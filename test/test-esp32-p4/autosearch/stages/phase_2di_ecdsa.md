# Phase 2.DI — ECDSA peripheral (TRM Chapter 31) — NIST P-256 sign + verify

**Estado**: ✅ done — adds the ECDSA Digital Signature peripheral at
the correct base **0x50096000** (CRYPTO_BASE + 0x6000), implementing
NIST P-256 (SECP256R1) **sign / verify / export-pubkey** with embedded
affine elliptic-curve arithmetic over the fuzz-verified RSA bignum.
This is the modern-TLS counterpart to RSA — ESP secure-boot-v2 and
most current TLS suites use ECDSA P-256.

Live verification (all 4 operations at boot):

```
[esp32p4.ecdsa] op#1 export → result=1            Q = d·G
[esp32p4.ecdsa] op#2 sign   → r=OK s=OK           (r,s) == oracle EXACTLY
[esp32p4.ecdsa] op#3 verify → result=1            valid sig accepted
[esp32p4.ecdsa] op#4 verify → result=0            tampered sig rejected
```

The SIGN output reproduces the deterministic oracle bit-for-bit:
`r = bb627471…28ff0619`, `s = 9def6a16…21a04437` — the exact signature
that Python's `cryptography` library independently verified.

## Workflow-driven methodology (ULTRACODE)

A **lean** `ecdsa-understand` workflow (2 IDF-source readers +
synthesis) — deliberately scoped after the DS phase hit session
limits. It skipped the session-risky TRM-PDF reader (IDF source is
authoritative for the register interface; the NIST P-256 params I
supplied directly in the synthesis prompt). **It completed cleanly,
no session limit.** Resolved: register map, the LOAD→[compute]→GET/IDLE
state machine, bank endianness, k-source, and the exact verify math.

A separate verify workflow was deliberately **not** run — the
deterministic Python oracle (generated + pre-validated against the
`cryptography` library before implementation) is a stronger and
cheaper check: the self-test reproducing the exact oracle (r,s) IS the
adversarial verification.

## Lo que SE INVESTIGÓ

### 1. Register / bank map (ecdsa_reg.h + ecdsa_ll.h, authoritative)

Base `0x50096000`, IO window 0x1000, little-endian, 4/4 access.

| Offset | Reg/Bank | Notes |
|--------|----------|-------|
| 0x004 | CONF | WORK_MODE[1:0] (0=verify,1=sign,2=export), CURVE[2] (1=P256), SOFT_K[3], SOFT_Z[4], DET_K[5] |
| 0x01C | START | bit0 START_CALC, bit1 LOAD_DONE, bit2 GET_DONE |
| 0x020 | STATE (RO) | 0=IDLE,1=LOAD,2=GET,3=BUSY |
| 0x024 | RESULT (RO) | bit0 OPERATION_RESULT (1=verify pass/op ok), bit1 K_WARNING |
| 0x00C..0x18 | INT_RAW/ST/ENA/CLR | bit0 CALC_DONE |
| 0x0FC | DATE | default 0x02302C30 |
| 0x218 | SHA_BUSY (RO→0) | on-chip SHA path (out of scope) |
| 0xA00/0xA20/0xA40/0xA60/0xA80 | R/S/Z/QAX/QAY MEM (32 B each) | LE 32-bit words |

All banks are little-endian 32-bit-word byte arrays — identical to
RSA's `bn_from_bank`/`bn_to_bank`, no swaps anywhere.

### 2. The 3-stage state machine (ecdsa_hal.c)

```
write START.START_CALC (bit0) → state = LOAD     (CONF latched)
write START.LOAD_DONE  (bit1) → consume banks, compute();
                                 VERIFY → IDLE; SIGN/EXPORT → GET
write START.GET_DONE   (bit2) → state = IDLE
```
VERIFY has no GET phase (goes LOAD→IDLE); SIGN/EXPORT go LOAD→GET→IDLE.
The model returns `s->state` on STATE reads; compute is instantaneous,
so the guest's `while(state != X)` polls succeed immediately.

### 3. Operations as exact C-level math

- **VERIFY(z,r,s,Qx,Qy)**: reject if r,s ∉ [1,n−1]; w = s⁻¹ mod n;
  u1 = (z mod n)·w mod n; u2 = (r mod n)·w mod n; P = u1·G + u2·Q;
  valid iff (P.x mod n) == r.
- **SIGN(z,d[,k])**: r = (k·G).x mod n; s = k⁻¹(z + r·d) mod n.
- **EXPORT(d)**: Q = d·G.

### 4. Key + nonce sources

- **d (private key)** comes from eFuse (KEY_PURPOSE=ECDSA_KEY=1) on
  silicon, never leaving the chip — no software d bank. The model uses
  a fixed documented test scalar as the provisioned key (no real test
  vector ties a fused key to a signature; documented divergence).
- **k (nonce)** is internal (TRNG) on silicon → non-reproducible. The
  model defaults to a deterministic RFC-6979-lite k =
  SHA256(d‖z) mod (n−1) + 1, and honors the SOFTWARE_SET_K register bit
  (k from the QAX bank) so the self-test can pin k for reproducibility.

### 5. NIST P-256 params

Standard SECP256R1 / FIPS 186-4 constants, baked as big-endian byte
arrays + a `bn_from_be` loader (transcribed directly from the standard
hex — less error-prone than hand-reversing to LE limbs).

## Lo que SÍ funcionó

1. ✅ **SIGN bit-perfect vs the oracle**: with the fixed d + k, the
   peripheral produces r=`bb627471…`, s=`9def6a16…` — exactly the
   oracle, which the `cryptography` library independently verified.
   This cross-validates the entire EC scalar-mult + sign equation.
2. ✅ **VERIFY accepts the valid signature** (op#3 result=1) and
   **rejects a 1-bit-tampered r** (op#4 result=0).
3. ✅ **EXPORT** produces the pubkey Q=d·G (consumed by the verify,
   which passed → Q is correct).
4. ✅ The EC math was pre-validated in Python (my affine point ops
   matched `cryptography` before a line of C was written).
5. ✅ Reused the fuzz-verified RSA bignum (16,343 cases) verbatim —
   the field/scalar arithmetic foundation was already trusted.
6. ✅ State machine, IRQ (CLIC cause 39), DATE=0x02302C30, reset
   deasserts the line. 38th JSON event type unchanged + new `ecdsa`
   → **39 event types**. No regression.

## Lo que NO funcionó / decisiones tomadas

### Performance bug found + fixed: Fermat modinv → binary GCD

**First build timed out** (no self-test output, exit 124). Root cause:
affine point arithmetic calls a modular inverse inside *every* point
double/add (~1500 per scalar-mult chain), and the inverse was Fermat
(`a^(p−2) mod p` = a full 256-bit modexp ≈ 256 modmuls). That's
~1500 × 256 modmuls ≈ unusably slow (>15 s).

**Fix**: replaced the Fermat inverse with **binary extended GCD**
(`bn_modinv` via shift/subtract, O(bits) cheap iterations). ~30×
faster — the self-test now completes in ~2 s of compute. `bn_modexp`
became unused and was removed.

### Remaining perf limitation (documented)

Even with binary-GCD inverses, a VERIFY (2 scalar-mults, ~500 point
ops each with an inverse) takes ~0.7 s on the triggering MMIO write.
Functional (the guest polls STATE which returns idle instantly, so no
hang), but a real TLS handshake's verify blocks the QEMU thread for
~0.7 s. **Future optimization**: Jacobian (projective) coordinates
defer the inverse to ONE final affine conversion (~1 inverse per
scalar-mult instead of ~500), ~100× faster. Deferred — correctness
first.

### Decisiones tomadas

1. **Affine coords + binary-GCD inverse** over Jacobian: keeps the
   point formulas simple and matching my Python-validated reference.
   Jacobian is the perf win but a bug-risk rewrite; deferred.
2. **Embed the bignum verbatim** (don't cross-link RSA): codebase
   convention; the bn functions are static, no symbol clash.
3. **P-256 only** (P-192 path wired via the CONF bit but math targets
   P-256): P-256 is the dominant curve.
4. **Fixed model d + software-K self-test** for reproducibility, with
   the eFuse-key / TRNG-k divergence documented (same honest-scoping
   as DS).
5. **Verify inline via the pre-validated oracle**, not a 2nd workflow:
   cheaper + stronger (the oracle is cryptography-verified).

## Lessons learned

1. **Affine EC with per-point modular inverse is a performance trap.**
   The math is correct but each inverse is expensive; doing one per
   point op is ~1500× the necessary inverses. Binary-GCD inverse was
   the cheap fix; Jacobian is the real fix. Worth knowing before
   reaching for affine in any EC code.
2. **A pre-validated oracle beats a verify workflow for deterministic
   crypto.** Generating the P-256 vector in Python + confirming it
   against `cryptography` BEFORE implementation meant the self-test's
   exact-match was the verification — no second workflow, no session-
   limit risk, stronger signal.
3. **Lean workflows dodge the session limit.** Two focused IDF readers
   + synthesis (skipping the PDF reader) completed cleanly where the
   DS phase's 5-agent workflow hit limits. Scope the research to what
   the authoritative source actually answers.
4. **Reusing verified subsystems compounds.** The bignum (fuzz-proven
   in 2.DG) carried the entire field/scalar arithmetic; only the EC
   point layer + ECDSA equations were new, and those were Python-
   validated. The new verification surface was small.

## Implementación final

### `include/hw/misc/esp32p4_ecdsa.h` (new)
Register/bank offsets, CONF/START/STATE/RESULT bit defines, state
struct (storage, op_count, state, work_mode, curve_p256, result_reg,
event_log, boot_ns, intr_out, irq_level), self-test prototype.

### `hw/misc/esp32p4_ecdsa.c` (new, ~720 LOC)
- bignum (verbatim from 2.DG) + bn_from_be / bn_add / bn_addmod /
  bn_submod / bn_shr1 / bn_halve_mod / **binary-GCD bn_modinv**.
- P-256 params (BE byte constants) + ec_init_params.
- Affine point ops: ecp_double, ecp_add, ecp_mul (double-and-add).
- ecdsa_verify / ecdsa_sign / ecdsa_export + ecdsa_det_k (RFC-6979-lite).
- compute() dispatcher + state machine; read (STATE/RESULT/INT_ST/
  SHA_BUSY overrides), write (START stages + INT), reset (DATE + IRQ
  deassert), realize, class/type.
- Self-test: EXPORT + SIGN (software-K) + VERIFY valid + VERIFY
  tampered on the Python-cross-validated vector.

### `hw/misc/meson.build`
Added `esp32p4_ecdsa.c`.

### `hw/riscv/esp32p4.c`
`#include esp32p4_ecdsa.h`; `ESP32P4EcdsaState ecdsa` field; mapped at
0x50096000 (priority-2 overlay over the HP catch-all) + event_log/
boot_ns + INT→cause 39 + self-test.

## Estado consolidado (post-2.DI)

Crypto subsystem — now spans both signature families:

| Peripheral | TRM Ch | Status |
|------------|--------|--------|
| AES | 25 | AES-128/192/256 ECB ✓ |
| SHA | 29 | 8/8 modes ✓ |
| HMAC | 27 | HMAC-SHA-256 multi-block ✓ |
| RSA | 28 | modexp/modmult/mult ✓ |
| Digital Signature (RSA) | 30 | full pipeline ✓ |
| **ECDSA** | **31** | **P-256 sign/verify/export ✓ (this phase)** |
| ECC_MULT | 26 | stub (correct addr) |

JSON event types: **39** (adds `ecdsa`). CLIC causes used: …37 (RSA),
38 (DS), 39 (ECDSA).

## 97-Phase realism progression

| Phase | Capability |
|-------|------------|
| 2.DG | RSA accelerator |
| 2.DH | Digital Signature peripheral |
| **2.DI** | **ECDSA peripheral — P-256 sign/verify/export** |

A guest's `mbedtls_ecdsa_*` / ECDSA-P-256 TLS handshake or secure-boot
signature verify now has a working hardware accelerator.

## Próximas direcciones

- **Jacobian coordinates** for ECDSA — defer the modular inverse to a
  single final affine conversion (~100× faster verify). Perf only.
- **P-192** curve math (the path is wired; just needs the P-192 params
  + length switch).
- **ECC_MULT (TRM 26)** raw scalar point multiply as a standalone
  accelerator (the ECDSA EC core could be shared).
- **ECDSA from eFuse key + TRNG k** — wire the real eFuse ECDSA key
  block + a TRNG-sourced nonce (faithful key routing).
- **DMA controller** (unblocks AES-CBC/GCM/XTS + DMA-SHA), BME688,
  UART RX chardev injection, FreeRTOS resurrection.
