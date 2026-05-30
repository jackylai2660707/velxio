# Phase 2.DH — Digital Signature peripheral (RSA_DS, TRM Chapter 30)

**Estado**: ✅ done — the crypto-subsystem capstone. Replaces the
(mislabeled) DS smart_stub with a real Digital Signature peripheral
at the correct base **0x50094000**, implementing the full silicon
data-flow: HMAC-SHA256 key derivation → AES-256-CBC decrypt of the
encrypted private-key blob → MD5 integrity check → RSA modexp
signature. Composes the AES core (2.CO), the RSA bignum (2.DG), the
shared SHA-256 (2.CP), and a new MD5.

Live verification (full DS sign at boot):

```
[esp32p4.ds] op#1 sign N=1 md5=OK check=0 → Z prefix: f90b000000000000
{"event":"ds","op":1,"words":1,"md5_ok":true,"check":0,"key_wrong":0,
 "sig_prefix":"f90b000000000000"}

Z prefix f90b = 0x0BF9 = 3065 = 42^2753 mod 3233  ✓ (RSA signature)
md5=OK    → AES-256-CBC decrypt reproduced the plaintext exactly
check=0   → QUERY_CHECK = signature OK
```

## Workflow-driven methodology (ULTRACODE) + session-limit caveat

This phase used a research workflow (`ds-understand`, 5 agents) but
hit a real-world constraint worth documenting: **the workflow's TRM
reader, key-derivation reader, and synthesis agent all hit the
account session limit mid-run.** Only the register-layout reader and
the driver reader returned full findings. So:

- ✅ Got from the workflow: the authoritative DS register/bank map +
  the **base-address correction** (0x50094000, not the stub's
  0x50093000 = ECC_MULT) + the esp_ds.c blob format + operation
  sequence.
- ❌ Lost to the session limit: TRM Ch 30 §30.3.2 (exact field order
  vs espsecure.py) and the precise ROM downstream-HMAC key-derivation
  message constant.
- 🔧 Adapted: I synthesized the spec myself from the two complete
  findings + direct reads of `ds_reg.h`, and chose a scope that's
  faithful to the algorithm while honest about the unconfirmed ROM
  constant (see below). Verification was done **inline** (standalone
  C harness vs Python) rather than via another workflow, to avoid
  re-hitting the limit.

**Lesson: workflows are powerful but not infallible — when agents
fail, the orchestrator must be ready to synthesize + verify directly.
The partial findings (regs + driver) were still enough to build a
correct peripheral.**

## Lo que SE INVESTIGÓ

### 1. Base address correction (real bug fixed)

`reg_base.h`: `DR_REG_DS_BASE = DR_REG_CRYPTO_BASE + 0x4000 =
0x50094000`. The crypto block is:
```
AES 0x50090000 | SHA 0x50091000 | RSA 0x50092000 |
ECC_MULT 0x50093000 | DS 0x50094000 | HMAC 0x50095000 | ECDSA 0x50096000
```
The QEMU tree mapped a DS smart_stub at **0x50093000** — that's
ECC_MULT. Fixed: relabeled the 0x50093000 stub to `esp32p4.ecc` and
mapped the real DS peripheral at 0x50094000.

### 2. DS register / memory map (ds_reg.h, authoritative)

| Offset | Bank/Reg | Size | Notes |
|--------|----------|------|-------|
| 0x000 | Y_MEM | 512 B | ciphertext frag 1 |
| 0x200 | M_MEM | 512 B | ciphertext frag 2 |
| 0x400 | RB_MEM | 512 B | ciphertext frag 3 |
| 0x600 | BOX_MEM | 48 B | ciphertext frag 4 (enc MD5/M'/length/pad) |
| 0x630 | IV_MEM | 16 B | AES-CBC IV |
| 0x800 | X_MEM | 512 B | message to sign |
| 0xA00 | Z_MEM | 512 B | signature result (RO) |
| 0xE00 | SET_START | WT | kicks HMAC key derivation |
| 0xE04 | SET_CONTINUE | WT | begins the sign |
| 0xE08 | SET_FINISH | WT | finalize |
| 0xE0C | QUERY_BUSY | RO→0 | always idle (instantaneous) |
| 0xE10 | QUERY_KEY_WRONG | RO | key-error count |
| 0xE14 | QUERY_CHECK | RO | bit0=MD_ERROR, bit1=PADDING_BAD |
| 0xE20 | DATE | RW | default 538969624 = 0x20200618 |

The ciphertext spans Y_MEM..BOX_MEM **contiguously** = 1584 bytes =
99 AES blocks.

### 3. The encrypted blob (esp_ds.c / ROM digital_signature.h)

Plaintext (1584 B, decrypted from the C blob):
```
Y[512]  : RSA private exponent d
M[512]  : RSA modulus
Rb[512] : r-inverse (Montgomery; ignorable for the math)
MD5[16] : MD5(Y || M || Rb || M' || length)
M'[4]   : Montgomery constant
length[4]: RSA length in words
pad[24] : padding
```
AES-256-CBC encrypted with a key derived via HMAC-SHA256 from an
eFuse key block (KEY_PURPOSE = HMAC_DOWN_DIGITAL_SIGNATURE = 7),
IV from the IV bank. The signature is `Z = MSG^Y mod M` — a plain RSA
modexp our engine computes.

### 4. Key derivation — the ROM-opaque part

`esp_ds.c` calls `hmac_hal_configure(HMAC_OUTPUT_DS, key_id)`: the
HMAC peripheral runs in downstream-DS mode and feeds the 256-bit
result directly to the DS AES engine (never readable by software).
The exact downstream HMAC message constant is **not exposed in IDF
source** (it's ROM/hardware-internal). This is the one piece that
can't be made byte-identical to real silicon without the ROM
constant.

## Scope decision: data-flow-faithful, self-consistent

Three options were on the table:
- **(A) Full faithful**: decrypt a real espsecure.py blob. Infeasible
  — needs the exact ROM key-derivation constant (unknown) + the eFuse
  key.
- **(B) Self-consistent faithful** (CHOSEN): implement the complete
  real pipeline (HMAC-SHA256 + AES-256-CBC + MD5 + RSA modexp) with a
  fixed, documented key-derivation constant; the self-test generates
  the blob with the *same* derivation. This is faithful to the chip's
  **data flow** — every step the silicon performs, performed for real
  — and bit-exact for any blob generated with the matching
  derivation. A real espsecure.py blob fails the MD5 check →
  QUERY_KEY_WRONG, which is *also* the correct silicon behavior for a
  key mismatch (graceful degradation).
- **(C) Register skeleton**: probe-survivable only. Rejected — too
  shallow for "closest to a physical chip".

Scope B gives a peripheral that genuinely decrypts, integrity-checks,
and RSA-signs — the real algorithm — while being honest that the ROM
key-derivation constant is approximated.

## Lo que SÍ funcionó

1. ✅ **Full pipeline end-to-end on the first build**: the self-test
   generates a blob (HMAC key-deriv → MD5 → AES-256-CBC encrypt),
   loads it, and the peripheral derives the same key, AES-CBC
   decrypts, verifies MD5 (OK), and RSA-signs → `0xBF9` =
   pow(42,2753,3233). No debugging cycle.
2. ✅ **MD5 cross-checked vs Python** (3 vectors, inline standalone
   harness): `d41d8cd9…` (empty), `900150983cd2…` ("abc"),
   `9e107d9d37…` (fox) — all bit-perfect. The new MD5 is standard
   RFC 1321.
3. ✅ **AES-256-CBC cross-checked vs Python `cryptography`** (inline
   harness, extracted the actual `aes256_cbc_encrypt` from the source
   via `sed`): `4f45ae3d…208a7226` — bit-perfect.
4. ✅ AES block: FIPS-validated (verbatim copy from 2.CO, whose
   self-test produces the canonical 3925841d ciphertext).
5. ✅ HMAC-SHA256: built on the bit-perfect `esp32p4_sha256()`
   (2.CP); the wrapper matches the HMAC peripheral's (2.CN, validated
   vs Python `hmac`).
6. ✅ bignum modexp: verbatim from 2.DG (fuzz-verified 16,343 cases).
7. ✅ Base-address bug fixed (0x50093000→0x50094000; stub relabeled
   to ecc). DATE = 0x20200618 confirmed from ds_reg.h.
8. ✅ DS completion IRQ → CLIC cause 38. Reset deasserts the line
   (qemu_set_irq, applying the 2.DG lesson). 38th JSON event type
   (`ds`). No regression on AES/SHA/RSA/etc.

## Lo que NO funcionó / decisiones tomadas

### Workflow session limit (documented above)
Three of five agents failed mid-run; synthesized + verified manually.

### Decisiones tomadas

1. **Embed primitives, don't cross-link TUs.** The AES core + bignum
   are copied verbatim into `esp32p4_ds.c` (both already proven). MD5
   is new. HMAC reuses the *exported* `esp32p4_sha256()`. This avoids
   exporting AES/RSA internals across translation units (the
   synthesis-recommended low-coupling approach).
2. **Fixed DS_ROOT_KEY + DS_DERIV_MSG constants** for the key
   derivation, matched by the self-test blob generator. Documented as
   the approximation for the ROM-opaque downstream message.
3. **Pipeline runs on SET_CONTINUE** (the driver writes IV/message/
   blob between SET_START and SET_CONTINUE). SET_START is a no-op in
   our instantaneous model; SET_FINISH clears the IRQ latch.
4. **QUERY_BUSY → always 0** (idle), QUERY_CHECK/QUERY_KEY_WRONG from
   latches set by the sign. A wrong-key blob → MD5 fail → both set,
   matching `ds_ll_check_signature`'s {OK/MD_FAIL/PAD_FAIL} decode.
5. **Inline verification over a 2nd workflow.** Given the session
   limit, the standalone-harness-vs-Python cross-check (the same
   technique the rsa-verify fuzz agent used) was run directly.

### Documented limitations
- The ROM downstream-HMAC message constant is approximated, so a real
  espsecure.py blob won't decrypt (it fails the MD5 check → the
  correct "wrong key" silicon behavior, not a crash).
- The HMAC→DS internal key handoff (HMAC peripheral downstream mode)
  isn't wired; DS derives the key itself. Faithful to the data flow,
  not to the inter-peripheral key routing.
- TRM Ch 30 §30.3.2 field-order vs espsecure.py unconfirmed
  (session-limit); the layout follows the driver agent's reading of
  esp_ds.c / ROM digital_signature.h.

## Lessons learned

1. **Workflows can fail; the orchestrator must absorb the gap.** When
   3/5 research agents hit the session limit, the 2 that completed
   (regs + driver) plus direct source reads were enough. Don't let a
   partial workflow block the phase — synthesize what you have.
2. **Inline standalone-harness verification scales down from
   workflows.** The MD5 + AES-CBC cross-check (extract function via
   `sed`, compile with gcc, diff vs Python) is the same rigor as the
   rsa-verify fuzz agent, runnable in one bash call — no workflow,
   no session-limit risk.
3. **Composition pays compounding dividends.** DS reused 4 already-
   verified subsystems (AES, SHA, HMAC, RSA bignum). Only MD5 + the
   blob assembly were new, so the verification surface was small —
   two cross-checks closed it.
4. **A mislabeled stub is a latent bug.** The "esp32p4.ds" stub at
   0x50093000 (actually ECC_MULT) would have silently shadowed a
   future ECC peripheral and put DS at the wrong address. The
   register-layout research surfaced it.

## Implementación final

### `include/hw/misc/esp32p4_ds.h` (new)
Register/bank offsets, state struct (storage, op_count, check_result,
key_wrong, event_log, boot_ns, intr_out, irq_level, int_pending),
self-test prototype, C_LEN=1584, DATE default.

### `hw/misc/esp32p4_ds.c` (new, ~700 LOC)
- AES-256 core (verbatim from 2.CO) + AES-256-CBC enc/dec wrappers.
- MD5 (RFC 1321, new).
- HMAC-SHA256 on `esp32p4_sha256()`.
- bignum modexp (verbatim from 2.DG).
- DS key derivation + `do_sign` pipeline (decrypt → MD5 → modexp).
- read (QUERY overrides), write (SET_* triggers + INT), reset
  (DATE + IRQ deassert), realize, class/type.
- Self-test: generate blob + sign message 42 → 0xBF9.

### `hw/misc/meson.build`
Added `esp32p4_ds.c`.

### `hw/riscv/esp32p4.c`
`#include esp32p4_ds.h`; `ESP32P4DsState ds` field; relabeled
0x50093000 stub to ecc; mapped real DS at 0x50094000 (priority-2
overlay) + event_log/boot_ns + INT→cause 38 + self-test.

## Estado consolidado (post-2.DH)

Crypto subsystem — now complete for the RSA family:

| Peripheral | TRM Ch | Status |
|------------|--------|--------|
| AES | 25 | AES-128/192/256 ECB ✓ (2.CO) |
| SHA | 29 | 8/8 modes ✓ (2.CP..2.DD) |
| HMAC | 27 | HMAC-SHA-256 multi-block ✓ (2.CM..2.CV) |
| RSA | 28 | modexp/modmult/mult ✓ (2.DG) |
| **Digital Signature** | **30** | **full pipeline ✓ (this phase)** |
| ECC_MULT | 26 | stub (correct addr now) |
| ECDSA | 31 | stub |

JSON event types: **38** (adds `ds`).

## 96-Phase realism progression

| Phase | Capability |
|-------|------------|
| 2.DF | MS5611 CRC-4 PROM |
| 2.DG | RSA accelerator (workflow-driven + adversarially verified) |
| **2.DH** | **Digital Signature peripheral — crypto-subsystem capstone** |

A guest's `esp_ds_sign` / DS-backed TLS client-cert path now has a
peripheral that performs the real decrypt + integrity-check + RSA
sign pipeline.

## Próximas direcciones

- **Wire the HMAC peripheral's downstream-DS key handoff** so DS uses
  the eFuse key block via the HMAC engine (faithful inter-peripheral
  key routing).
- **ECC_MULT (TRM 26) + ECDSA (TRM 31)** — modern TLS uses ECDSA
  P-256/P-384 more than RSA; the next big crypto target.
- **espsecure.py blob compatibility** — would need the ROM
  key-derivation constant (reverse-engineer or read TRM Ch 30 when
  session allows).
- **RSA Montgomery/Barrett fast path** (perf), DMA controller
  (unblocks AES-CBC/GCM/XTS + DMA-SHA), BME688, UART RX chardev
  injection, FreeRTOS resurrection.
