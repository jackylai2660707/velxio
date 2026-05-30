# Phase 2.DP — AES cipher-mode completion (GCM decrypt, AES-256-GCM, CTR)

**Estado:** ✅ DONE — the AES-DMA path now covers the **complete cipher-mode
+ AEAD surface**: ECB / CBC / CTR / GCM, encrypt + decrypt, 128- + 256-bit,
all NIST-verified. The full TLS record path (encrypt-to-send,
decrypt-and-verify-tag) is closed.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_aes.c` (GCM decrypt path +
  4 new self-test vectors)

---

## SE INVESTIGÓ (what was researched)

2.DO gave GCM **encrypt**; 2.DN gave ECB/CBC and an **untested** CTR path.
This phase closes the gaps that matter for a real TLS stack:
- **GCM decrypt + tag verify** — the receive side of every AES-GCM TLS
  record. The model produces plaintext + the tag; a real driver does the
  constant-time tag compare, so a tamper test must show the tag *changes*.
- **AES-256-GCM** — TLS 1.3's `TLS_AES_256_GCM_SHA384`.
- **AES-CTR** — used directly and as GCM's core; was implemented but never
  validated.

All four reference vectors were cross-checked with Python `cryptography`
before coding (NIST SP800-38A CTR F.5.1; NIST GCM AES-256 TC; GCM-128
decrypt round-trip), so the C self-test byte-compare is the verification.

---

## SÍ funcionó (what worked)

- **GCM decrypt = GHASH over the *input*.** The one subtlety: GHASH always
  runs over the **ciphertext**. On encrypt the ciphertext is the *output*
  (GHASH after CTR); on decrypt the ciphertext is the *input* (GHASH before
  CTR turns it into plaintext). Fix: snapshot the block-padded input into
  `ghash_ct[]` when `decrypt`, run CTR in place (self-inverse), then GHASH
  the snapshot. One `bool decrypt` param threaded into `esp32p4_aes_gcm_run`.
- **Tamper-reject works for free.** Flipping one ciphertext byte changes
  the GHASH input → a different tag → `tag != expected`, exactly what a
  driver's `mbedtls_ct_memcmp` would reject. Verified.
- **AES-256-GCM through the same code.** Only the key length / round count
  differ; the GCM orchestration is key-size-agnostic. The self-test helper
  took an explicit `mode` param so EN-128 / DE-128 / EN-256 all route through.
- **CTR validated.** The 2.DN full-128-bit-block counter increment matches
  NIST SP800-38A (the counter `…feff → …ff00` carry is handled).
- **All green in running QEMU, first build:**
  ```
  self-test DMA: ECB128=OK CBC128=OK CBC128-dec=OK CTR128=OK
  self-test GCM: TC3=OK TC4=OK dec=OK tamper=OK GCM256=OK
  ```

---

## NO funcionó / decisiones (what failed + decisions made)

- **No failures** — Python-pre-validation + the existing GHASH/CTR/DMA
  machinery meant each addition was small and correct first try.
- **Tag *verification* stays in software** (faithful): the silicon produces
  the tag in `AES_T0_MEM`; the driver compares it constant-time. The model
  produces the tag and the *tamper test asserts the produced tag differs* —
  it does not itself reject, because the hardware doesn't either.
- **Scope intentionally bounded** to ECB/CBC/CTR/GCM. CFB/OFB and GCM
  streaming (CONTINUE across calls), AAD-only / zero-length-text edge cases
  are not added (rarely used; flagged if a guest needs them).

## Lessons learned

1. **For an AEAD, the decrypt path's only twist is "GHASH the input."**
   Everything else (CTR symmetry, the H/J0/len machinery) is shared with
   encrypt — so decrypt was ~10 lines once that was seen.
2. **A tamper test is the cheapest proof an auth tag is real.** One flipped
   byte + "tag changed" assertion validates the whole GHASH chain end-to-end
   without a second oracle.

## Estado consolidado (AES-DMA cipher modes)

| Mode | Enc | Dec | 128 | 256 | Verified vector |
|------|-----|-----|-----|-----|-----------------|
| ECB  | ✅ | ✅ | ✅ | ✅ | FIPS-197 |
| CBC  | ✅ | ✅ | ✅ | — | SP800-38A |
| CTR  | ✅ | (=enc) | ✅ | — | SP800-38A F.5.1 |
| GCM  | ✅ | ✅ + tamper | ✅ | ✅ | NIST GCM TC3/TC4/256 |

## Próximas direcciones (next)

- **INTMTX** (interrupt matrix) — the top structural gap.
- **Variety pivot**: I2S audio (showcases the AHB-DMA the same way crypto
  showcased AXI-DMA), TSENS on-chip temp sensor, PCNT pulse counter.
- DMA-SHA-512 multi-block; CFB/OFB if needed.
