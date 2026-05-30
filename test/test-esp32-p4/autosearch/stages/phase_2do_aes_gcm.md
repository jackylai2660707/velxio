# Phase 2.DO — AES-GCM via DMA (GHASH + auth tag)

**Estado:** ✅ DONE — full AES-GCM (the AEAD mode TLS 1.3 uses) over the
AXI-DMA path: H/J0/GHASH/tag, ciphertext to the in-link, tag to T0_MEM.
Verified byte-exact against NIST GCM Test Cases 3 (block-aligned) and 4
(partial AAD + partial text). Crypto-DMA now covers the modern TLS suite.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_aes.c` (+GHASH + gcm_run +
  GCM self-test; ECB/CBC/CTR path untouched)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_aes.h` (+H/J0/T0/AAD
  regs, BLOCK_GCM, self-test decl)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (call GCM self-test)
- `test/test-esp32-p4/autosearch/scripts/run_gcm_selftest.sh`

---

## SE INVESTIGÓ (what was researched)

GCM is the authenticated-encryption mode modern TLS (1.2 GCM suites, 1.3)
uses, and a real ESP32-P4 hardware mode (`BLOCK_MODE=6`, with H/J0/T0
registers + AAD/remainder controls). Two tracks:

1. **From-scratch GHASH + GCM in Python**, validated against NIST GCM
   Test Cases 3 + 4 AND the `cryptography` library — this is the
   **bit-exact reference** for the C GHASH. Confirmed the reflected
   GF(2¹²⁸) convention (process H bits MSB-first, reduction R=0xE1 into
   the top byte on LSB-out), H = E(K,0¹²⁸), J0 = IV‖0³¹‖1 (96-bit IV),
   counter = inc32(J0), tag = GHASH(A‖C‖len) ⊕ E(K,J0).
2. **An `aes-gcm-research` Workflow** (2 readers → synthesis) over
   `aes_ll.h` / `aes_hal.c` / `esp_aes_gcm.c` / `esp_aes_dma_core.c`,
   which resolved the exact hardware flow:
   - **H is hardware-computed**: with key + `BLOCK_MODE=GCM` set,
     `aes_hal_gcm_calc_hash` triggers a transform with no text loaded;
     the accelerator produces H = E(key,0¹²⁸); software reads `AES_H_MEM`.
   - **J0 is software-computed** (`esp_gcm_derive_J0`) and written to
     `AES_J0_MEM`. (96-bit IV fast path; otherwise a GHASH over the IV.)
   - **DMA stream framing**: a *single* in-link =
     `[AAD blocks][text blocks][16-byte len block]`. The first
     `AES_AAD_BLOCK_NUM` (=ceil(aad_len/16)) blocks are AAD (GHASHed, not
     encrypted); `AES_BLOCK_NUM` (=ceil(text_len/16)) text blocks follow;
     a trailing `len_desc` = `[0, bswap32(aad_len*8), 0, bswap32(text_len*8)]`.
   - **Key insight on the len block**: the driver's bswap32 + little-endian
     word store produces, in memory, exactly the canonical big-endian
     `len(A)₆₄ ‖ len(C)₆₄` GHASH length block — so the model reads it
     verbatim and GHASHes it (and reads c_len/aad_len from it).
   - Ciphertext → RX in-link; tag read from `AES_T0_MEM`;
     `AES_REMAINDER_BIT_NUM` = `(8*text_len) % 128` for the partial tail.

---

## SÍ funcionó (what worked)

- **Python-first validation = green first build.** Because the
  from-scratch GHASH already matched NIST TC3+TC4 bit-exact, the C GHASH
  was a direct transcription (uint8[16], MSB-first H scan, 0xE1 reduce)
  and the self-test's byte-compare passed on the first run:
  ```
  op#7 DMA GCM aad=0 txt=4 → tag: 4d5c2af3...     (TC3)
  op#8 DMA GCM aad=2 txt=4 → tag: 5bc94fbc...     (TC4)
  self-test GCM: TC3(aligned)=OK TC4(AAD+partial)=OK
  ```
- **Partial-block path correct.** TC4 (AAD=20 bytes → 2 blocks last
  partial, text=60 bytes → 4 blocks last partial) verified both the
  ciphertext (60 bytes) and the tag. The model zero-pads the last AAD and
  ciphertext block for GHASH (the stream is block-padded), CTR-encrypts
  only the `c_len` valid text bytes (derived from the len block), and
  outputs only those bytes.
- **Composes the prior crypto-DMA work.** GCM = CTR (already in 2.DN) +
  GHASH (new) + the gather/scatter descriptor walks (2.DM/2.DN). The new
  code is the GHASH primitive + the GCM orchestration; the AES core,
  channel-binding, and DMA plumbing were reused.
- **Faithful register surface**: H_MEM (HW writes the subkey), J0_MEM (SW
  sets), T0_MEM (HW writes the tag), AAD_BLOCK_NUM, BLOCK_NUM,
  REMAINDER_BIT — all modeled. ECB/CBC/CTR path untouched (GCM branches
  out of `esp32p4_aes_dma_run` before the block loop).

---

## NO funcionó / decisiones (what failed + decisions made)

- **No failures this phase** — the Python-first discipline + workflow flow
  research meant the implementation matched on the first build. The main
  *decision* was deriving `c_len`/`aad_len` from the trailing len block
  rather than from `AES_REMAINDER_BIT_NUM` arithmetic: the len block is
  authoritative (it's what GHASH consumes anyway) and avoids a second
  source of truth. `REMAINDER_BIT` is stored but the lengths come from the
  len block.
- **Scope: encrypt-side, AES-128, no tag *verification***. The model
  produces ciphertext + tag (encrypt) and would also decrypt (CTR is
  self-inverse; GHASH still runs over the ciphertext) — but a *decrypt*
  self-test + the constant-time tag-compare/reject path isn't added yet.
  AES-256-GCM works through the same code (keylen switch) but isn't
  self-tested. Flagged in next.
- **AAD via the same out-link** (not a separate channel) — matches the
  IDF driver, which chains AAD→text→len descriptors into one in-link.

---

## Lessons learned

1. **Validate the crypto math from scratch in Python before C.** A
   from-scratch GHASH (not just the library) pinned the exact bit-reflected
   convention + reduction, so the C port had a byte-exact oracle and
   passed first try. For subtle primitives (GF(2¹²⁸), the reflection),
   the library alone wouldn't have taught the bit order.
2. **The driver's byte-order quirks often cancel.** The `bswap32` +
   little-endian word store of the len block lands as the canonical
   big-endian GHASH length block — so "no byte-swapping in the model"
   was correct. Reading the driver's actual memory layout (not just the
   field names) resolved it.
3. **Compose, don't rewrite.** GCM reused CTR + the DMA gather/scatter;
   only GHASH was genuinely new. Each crypto-DMA phase has narrowed to
   "the one new primitive."

## Implementación final (key shape)

- `aes_ghash_block(y, in, H)`: y = (y⊕in)·H, reflected GF(2¹²⁸),
  128-iter shift/reduce.
- `esp32p4_aes_gcm_run(s, rk, rounds, tlink, rlink)`: H=E(0)→H_MEM; read
  J0; gather `[AAD][text][len]`; CTR-encrypt `c_len` bytes from inc32(J0);
  GHASH(AAD‖C‖len); tag=GHASH⊕E(J0)→T0_MEM; scatter C to in-link;
  STATE=DONE. Branched from `esp32p4_aes_dma_run` on `BLOCK_MODE==GCM`.

## Estado consolidado (crypto-DMA)

| Path | Modes | Status |
|------|-------|--------|
| DMA-SHA (2.DM) | SHA-256 | ✅ FIPS 180-2 |
| DMA-AES (2.DN) | ECB, CBC (±) | ✅ FIPS-197 / SP800-38A |
| **DMA-AES-GCM (2.DO)** | **GCM (AEAD)** | **✅ NIST GCM TC3 + TC4** |

## Próximas direcciones (next)

- AES-GCM **decrypt** + tag-verify self-test; AES-256-GCM vector; AES-CTR
  self-test vector.
- DMA-SHA-512 multi-block.
- **INTMTX** (still the top structural interrupt gap).
- Variety: I2S audio (the other canonical DMA consumer).
