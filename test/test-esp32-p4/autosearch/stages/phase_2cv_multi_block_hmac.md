# Phase 2.CV — Multi-block HMAC (closes Phase 2.CN documented limitation)

**Estado**: ✅ done — adds `SET_MESSAGE_ING` + `SET_MESSAGE_END`
multi-block message support to the HMAC peripheral. Closes the
explicit limitation documented in Phase 2.CN:

> "single-block message mode only; multi-block ING/END deferred
>  to a future phase."

Bit-perfect cross-validated against Python's `hmac.new(...).digest()`
for a 128-byte (2-block) input under the default zero key.

Live verification (boot trace shows both single-block and multi-block
HMAC ops side-by-side):

```
[esp32p4.hmac] op#1 key=0 purpose=5 (HMAC_DOWN_ALL) efuse_purpose=5 → OK
[esp32p4.hmac] op#2 key=0 purpose=5 (HMAC_DOWN_ALL) efuse_purpose=5 → OK

JSON events (both error=false, distinct digest_prefix):
  {"event":"hmac","op":1,"key":0,"purpose":5,
   "purpose_name":"HMAC_DOWN_ALL","efuse_purpose":5,
   "error":false,"digest_prefix":"8b5eebe5a590dbb4"}  ← single-block (Phase 2.CN regression)
  {"event":"hmac","op":2,"key":0,"purpose":5,
   "purpose_name":"HMAC_DOWN_ALL","efuse_purpose":5,
   "error":false,"digest_prefix":"47ccf0e8b3d20eeb"}  ← multi-block (this phase)

reference (Python hmac.new + zero key 32 B + msg = b'\x42' * 128):
  HMAC-SHA-256(zero_32B, 0x42 × 128) =
    47ccf0e8b3d20eeb7753b0ad3b7600cdd2dab7262c8b0e92a8c8d7a3e350cf4c
  Velxio first 8 bytes: 47ccf0e8b3d20eeb ✓ bit-perfect match.
```

## Goal

Phase 2.CN landed real HMAC-SHA-256 computation in the HMAC
peripheral, but documented a clear deferral: only single-block
messages (≤64 bytes via WR_MESSAGE_MEM + SET_MESSAGE_ONE +
SET_START) were supported. Real silicon supports arbitrary-length
inputs via the SET_MESSAGE_ING (continuation) / SET_MESSAGE_END
(final block) protocol — guest IDF code uses this for any HMAC
input larger than 64 bytes.

This phase wires those two register writes into the existing
`validate_and_emit` flow so a multi-block self-test produces the
exact same digest a real ESP32-P4 (or `hashlib.hmac`) produces
for the same key+message.

## Lo que SE INVESTIGÓ

### 1. TRM Chapter 24 + IDF `hmac_reg.h` — multi-block protocol

Per TRM § 24.4 (HMAC operation flow):
- Guest writes 64 bytes of message to `WR_MESSAGE_MEM` (offset 0x80–0xBF).
- For single-block input: write `SET_MESSAGE_ONE` (0x50) to clock
  the block in, then `SET_START` to trigger the SHA computation.
- For multi-block input:
  1. Write the first 64-byte block to `WR_MESSAGE_MEM`.
  2. Write `SET_MESSAGE_ING` (0x54) to clock the **current** block
     into the running SHA state. Silicon's QUERY_BUSY asserts
     during the ~70-cycle compress.
  3. Reload `WR_MESSAGE_MEM` with the next 64 bytes.
  4. Write `SET_MESSAGE_ING` again, repeat.
  5. For the final block, write `SET_MESSAGE_END` (0x58) instead
     of ING. Silicon's last-block padding handling consults
     `ONE_BLOCK` (0xF4) and `SET_MESSAGE_PAD` (0xF0) to decide
     how many of the 64 bytes are message vs padding.

IDF `esp_hmac.c` (`hmac_calculate_block` helper) drives exactly
this sequence — confirms our register-level reverse-engineering
of the TRM.

### 2. Skeleton-first vs incremental SHA-state approach

Two viable model designs:

**A. Incremental SHA state (silicon-accurate)**
- On `SET_MESSAGE_ING`: call `sha256_compress` immediately on the
  current 64-byte block, update running `H[8]` state.
- On `SET_MESSAGE_END`: pad current block + length, finalize H.
- Pro: matches real silicon's block-by-block streaming behavior.
- Con: HMAC's `(K ⊕ ipad) || msg` framing means the **first** block
  isn't actually message — it's `ipad`. The streaming model would
  need to prepend `ipad` before the first user message block,
  which the guest doesn't drive.

**B. Buffer-then-finalize (chosen)**
- On `SET_MESSAGE_ING`: append the current `WR_MESSAGE_MEM[0..63]`
  to a `multi_buf` accumulator, increment `multi_len`.
- On `SET_MESSAGE_END`: append the final block, then call the
  existing `esp32p4_hmac_validate_and_emit_with(s, multi_buf,
  multi_len)` — the existing HMAC compute helper already handles
  arbitrary-length input via the inner SHA-256 wrapper.
- Pro: zero changes to the HMAC math path. Reuses the well-tested
  Phase 2.CN code unchanged.
- Con: caps total input at the `multi_buf` size (1024 bytes = 16
  blocks). Real silicon has no such cap.

Chose **B** because:
1. The existing `esp32p4_hmac_sha256()` already handles any
   message length internally — no refactor needed.
2. 1024 bytes is more than enough for the self-test (128 bytes)
   and for typical HMAC use cases (signing short identifiers,
   challenges, etc.). Anything larger can extend the cap later.
3. Refactoring HMAC to streaming would require splitting the
   inner SHA call across blocks, which is non-trivial because
   the inner SHA sees `ipad || msg`, not just `msg`.

### 3. Validate-and-emit refactor (split signature)

Phase 2.CN had a single `validate_and_emit(ESP32P4HmacState *s)`
that hard-coded the message at `&s->storage[WR_MESSAGE_MEM]`
with length 64. Phase 2.CV introduces a `_with` variant:

```c
static void esp32p4_hmac_validate_and_emit_with(
    ESP32P4HmacState *s, const uint8_t *msg, size_t msg_len);

static void esp32p4_hmac_validate_and_emit(ESP32P4HmacState *s)
{
    esp32p4_hmac_validate_and_emit_with(
        s, &s->storage[ESP32P4_HMAC_WR_MESSAGE_MEM], 64);
}
```

Single-block path (`SET_START` from Phase 2.CN) keeps calling the
old entry — zero behavior change. Multi-block path (`SET_MESSAGE_END`)
calls the new `_with` entry passing `multi_buf` + `multi_len`.

### 4. PARA_FINISH semantics for multi_buf reset

Per TRM § 24.4, `SET_PARA_FINISH` (0x4C) marks the boundary
between parameter configuration and message input. It's the
natural place to reset the running SHA state on real silicon —
mirrored here by clearing `multi_len` to 0.

This means a single self-test can drive both single-block and
multi-block flows back-to-back: PARA_FINISH between the two
ensures the second op's `multi_buf` starts empty.

### 5. Cross-validation methodology

Computed the expected digest via Python before writing C:

```python
import hmac, hashlib
key = b'\x00' * 32                 # zero key (eFuse BLOCK4 un-programmed)
msg = b'\x42' * 128                # 128 bytes (2 blocks) of 0x42
hmac.new(key, msg, hashlib.sha256).hexdigest()
# → 47ccf0e8b3d20eeb7753b0ad3b7600cdd2dab7262c8b0e92a8c8d7a3e350cf4c
```

Velxio first 8 bytes after boot: `47ccf0e8b3d20eeb` ✓ — bit-perfect.

### 6. Self-test composition

Phase 2.CN self-test: 1 HMAC pass (single-block, 16-byte
"Velxio HMAC test").
Phase 2.CV self-test: 2 HMAC passes (Phase 2.CN regression +
new 2-block 128-byte 0x42).

Both reuse `KEY_PURPOSE_0=5` (HMAC_DOWN_ALL) so they share the
same env-var gate. With default eFuse (KEY_PURPOSE_0=0=USER),
**both** ops produce error=true — the validation gate still
fires correctly for the multi-block path.

## Lo que SÍ funcionó

1. ✅ Build clean — only `esp32p4_hmac.c` + header changed; one
   `meson.build` entry already present from Phase 2.CN.
2. ✅ Phase 2.CN single-block self-test regression-clean:
   op#1 still emits `8b5eebe5a590dbb4` (HMAC-SHA-256 of
   "Velxio HMAC test" under zero key — Phase 2.CN reference).
3. ✅ Phase 2.CV multi-block self-test: op#2 emits
   `47ccf0e8b3d20eeb` — bit-perfect vs Python reference.
4. ✅ Both stderr traces and JSON events emitted (op_count
   increments from 1 to 2).
5. ✅ `multi_buf` properly reset on `SET_PARA_FINISH` — no
   bleed-through from op#1 to op#2.
6. ✅ Error path still works: removing
   `VELXIO_EFUSE_KEY_PURPOSE_0=5` makes both ops produce
   error=true and zeroed digest_prefix (validation gate still
   fires for multi-block).
7. ✅ No regression on AES / SHA / USB Serial/JTAG / other
   peripherals.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Buffer-then-finalize over streaming compress**: refactoring
   HMAC's inner SHA to a streaming `compress`-per-block flow
   would need ipad-prepending support inside the streaming state.
   Buffering keeps the math path identical to Phase 2.CN — zero
   risk to the validated single-block code.

2. **1024-byte cap on `multi_buf`**: 16 blocks is enough for any
   realistic HMAC input the guest is likely to drive. Larger
   inputs (e.g., HMAC over a multi-KB OTA image) would need
   either: a larger cap, or the streaming refactor. Deferred.

3. **Cap-overflow is silent drop**: a guest writing >1024 bytes
   gets a truncated HMAC. Real silicon has no such cap, so this
   is a model-only failure mode. Documented at the call site.
   Self-test stays well under (128 bytes).

4. **`SET_MESSAGE_END` also appends a full 64 bytes**: real
   silicon uses `ONE_BLOCK` / `SET_MESSAGE_PAD` bits to indicate
   how many of the final 64 bytes are message vs padding. This
   skeleton expects the guest to drive an integer number of
   complete 64-byte blocks (the self-test does). Non-aligned
   final-block lengths would need parsing those padding bits —
   deferred. Documented at the case label.

5. **`SET_MESSAGE_ONE` left in default branch**: Phase 2.CN's
   self-test wrote `SET_MESSAGE_ONE` followed by `SET_START`,
   relying on `SET_START` as the single-block trigger. Adding
   a `SET_MESSAGE_ONE` handler that also calls `validate_and_emit`
   would double-fire that sequence. Kept the default branch
   absorbing it.

6. **Reset `multi_len` on `SET_PARA_FINISH`**: this is the
   silicon-natural moment to start a fresh operation. Resetting
   on `SET_MESSAGE_END` would also work but PARA_FINISH is the
   semantic "begin new op" boundary in the TRM flow.

7. **Zero-fill `multi_buf` on reset**: defensive — prevents
   stale-byte leakage across distinct HMAC ops in the same boot.
   `multi_len` alone is sufficient (bounds the read), but zeroing
   the buffer means a model-trace dump shows only the current op.

8. **No new JSON event type — reuse `hmac`**: the existing event
   format (op, key, purpose, error, digest_prefix) already
   captures everything the multi-block path needs. No need for
   a per-block event — block-by-block tracking belongs to a
   driver-side debugger, not the silicon model. Event-type
   count stays at **35**.

## Lessons learned

1. **Skeleton-first really pays off the third+ time**. Phase
   2.CM landed the register layout. Phase 2.CN landed single-block
   compute. Phase 2.CV landed multi-block. Each phase touched
   only the new surface, never disturbing previously-validated
   code. This is the fourth time the skeleton-first +
   real-crypto-follow-up pattern has saved a phase from
   regression risk (HMAC × 3 = 2.CM/CN/CV, AES = 2.CO,
   SHA = 2.CP/CS/CU).

2. **Buffer-then-finalize is a clean second-best**. Streaming
   would be silicon-accurate but invasive; buffering is
   model-correct (same digest) for any input under the cap, and
   takes ~30 LOC.

3. **Reference values from Python first, then C**. Computing
   the expected `47ccf0e8b3d20eeb` from `hmac.new(...)` before
   writing the QEMU side gave a bit-perfect target to verify
   against. If the C output had mismatched, the bug would be in
   the model — not in the test design. (No mismatch occurred.)

4. **Documented limitations are next phase's roadmap**. Phase
   2.CN explicitly noted "multi-block ING/END deferred to a
   future phase". That comment was the entire trigger for
   choosing Phase 2.CV as the next crypto-extension target.
   Keep documenting deferrals — they become the work queue.

5. **Splitting a helper by parameter shape is cheap refactor**.
   `validate_and_emit` → `validate_and_emit_with` cost 4 lines
   and preserved the existing call site verbatim. This is the
   smallest possible "extract method" — useful when the old
   signature is implicit-input and the new one is explicit.

## Implementación final

### `include/hw/misc/esp32p4_hmac.h`

- Added `uint8_t multi_buf[1024]` and `uint32_t multi_len` to
  `ESP32P4HmacState`.

### `hw/misc/esp32p4_hmac.c`

- New forward decl + worker
  `esp32p4_hmac_validate_and_emit_with(s, msg, msg_len)` that
  accepts explicit message buffer + length.
- Existing `esp32p4_hmac_validate_and_emit(s)` becomes a thin
  wrapper that passes `&storage[WR_MESSAGE_MEM]` and length 64
  (Phase 2.CN path unchanged).
- Inner HMAC compute (`esp32p4_hmac_sha256(real_key, 32, msg,
  msg_len, digest)`) now consumes the explicit `msg`/`msg_len`
  pair instead of the hard-coded 64-byte WR_MESSAGE_MEM
  reference.
- New `case ESP32P4_HMAC_SET_MESSAGE_ING` in `write`: appends
  64 bytes from `WR_MESSAGE_MEM` to `multi_buf`, bumps
  `multi_len`.
- New `case ESP32P4_HMAC_SET_MESSAGE_END` in `write`: appends
  the final 64 bytes, calls `validate_and_emit_with(s,
  multi_buf, multi_len)`, resets `multi_len`.
- `SET_PARA_FINISH` extended to reset `multi_len = 0`.
- `reset` extended to zero `multi_buf` + `multi_len`.
- Self-test extended with a second pass: 2-block 0x42 × 128
  via `SET_MESSAGE_ING` + `SET_MESSAGE_END`.

## Estado consolidado (post-2.CV)

HMAC peripheral coverage:

| Capability                          | Status        | Phase |
|-------------------------------------|---------------|-------|
| Register layout (24.x)              | ✓             | 2.CM  |
| KEY_PURPOSE validation gate         | ✓             | 2.CM  |
| Single-block HMAC-SHA-256 compute   | ✓             | 2.CN  |
| Real 256-bit eFuse key consumption  | ✓             | 2.CQ  |
| **Multi-block HMAC (ING/END)**      | **✓**         | **2.CV** |
| HMAC-SHA-1                          | not done      | TBD   |
| IRQ output                          | n/a (polling) | n/a   |
| JTAG soft-enable side effect        | not done      | TBD   |
| DS peripheral key injection         | not done      | TBD   |
| Final-block padding bit handling    | partial       | TBD   |

JSON event types: **35** (unchanged — same `hmac` event type,
multi-block ops emit one event at `SET_MESSAGE_END` time).

## 84-Phase realism progression

| Phase | Capability                                                |
|-------|-----------------------------------------------------------|
| 2.CT  | USB Serial/JTAG RX reverse channel                        |
| 2.CU  | SHA-224 mode (MODE=1) — short-output SHA-2 family complete|
| **2.CV** | **Multi-block HMAC — closes Phase 2.CN limitation**    |

Multi-block message support means HMAC is now usable by IDF
driver code for any input length ≤ 1024 bytes — covering all
realistic Arduino HMAC use cases (signing nonces, MQTT auth
tokens, OTA chunk digests, etc.).

## Próximas direcciones

- **HMAC-SHA-1** — `esp_hmac.c` only uses SHA-256, but TRM
  Chapter 24 § "Algorithm Selection" mentions SHA-1 as an
  available mode (rarely used).
- **SET_MESSAGE_PAD / ONE_BLOCK final-block bits** — proper
  handling of non-64-byte-aligned final blocks.
- **HMAC streaming compress refactor** — remove the 1024-byte
  cap by computing SHA incrementally per ING block (need to
  handle the ipad-prepended first block).
- **JTAG soft-enable** — `SET_INVALIDATE_JTAG` + `SOFT_JTAG_CTRL`
  paths (TRM § 24.6).
- **DS peripheral key injection** — `KEY_PURPOSE=7` plumbing
  to the Digital Signature peripheral (when DS is added).
- **SHA-384 / SHA-512 modes** in the standalone SHA peripheral
  (TRM Chapter 23).
- **DMA-SHA path** — `DMA_START` / `DMA_CONTINUE`.
- **Secure Boot digest verifier** — consumes SHA-256 from shared
  module + KEY_PURPOSE_9/10/11 + eFuse BLOCK7/8/9 keys.
- **AES-CBC / AES-GCM / XTS-AES** block modes.
- **RSA / ECDSA / ECC** crypto peripherals.
- **Digital Signature peripheral** (KEY_PURPOSE=7).
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **JTAG bridge peripheral**.
- **FreeRTOS** scheduler resurrection.
