# Phase 2.DJ — ECC accelerator (ECC_MULT, TRM Chapter 26)

**Estado:** ✅ DONE — real peripheral at `0x50093000`, both NIST curves,
all field-mod modes, **byte-exact against IDF silicon-captured vectors**,
10/10 self-test checks green in running QEMU. Crypto subsystem
(AES + SHA + HMAC + RSA + DS + ECDSA + **ECC**) now functionally complete.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_ecc.c` (new, ~640 lines)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_ecc.h` (new)
- `third-party/qemu-lcgamboa/hw/misc/meson.build` (+1 line)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (include + struct field +
  init block at 0x50093000 + smart-stub comment; ECC IRQ → CLIC cause 40)
- `test/test-esp32-p4/autosearch/scripts/run_ecc_selftest.sh` (new run harness)

---

## SE INVESTIGÓ (what was researched)

The ECC_MULT accelerator is TRM Chapter 26 — the *raw* elliptic-curve
engine (scalar point multiply, point verify, point add, and field
modular add/sub/mul/inverse) over the two NIST curves the chip supports.
It is the layer **below** ECDSA: mbedtls' `ecp_alt` hardware path drives
ECC_MULT's POINT_MUL/VERIFY for every ECDSA *and* ECDHE operation.

Authoritative sources read this phase (IDF is ground truth for the
register layout; the TRM PDF reader was skipped as session-risky and
unnecessary given the IDF detail):

- `components/soc/esp32p4/include/soc/ecc_mult_reg.h` — full register map:
  - `INT_RAW@0xC` / `INT_ST@0x10` / `INT_ENA@0x14` / `INT_CLR@0x18`,
    all with `CALC_DONE` at **bit 0**.
  - `CONF@0x1C`: `START`[0] (R/W/SC, self-clears on done), `RESET`[1],
    `KEY_LENGTH`[2] (**0 = P-192, 1 = P-256**), `MOD_BASE`[3]
    (**0 = n curve order, 1 = p field prime**, only valid for modes 8-11),
    `WORK_MODE`[7:4], `VERIFICATION_RESULT`[29] (RO/SS).
  - `DATE@0xFC` default **36720704**.
  - Banks (32 bytes each): `K@0x100`, `PX@0x120`, `PY@0x140`,
    `QX@0x160`, `QY@0x180`, `QZ@0x1A0`.
- `components/hal/esp32p4/include/hal/ecc_ll.h` — work-mode codes 0-11
  (`ecc_ll_set_mode`), the `ecc_ll_param_t` bank enum, curve/mod_base
  setters, and the `start_calc`/`is_calc_finished` (polls INT_RAW[0]) flow.
- `components/hal/ecc_hal.c` — the **operand + result bank convention**
  per mode (the decision-critical part):
  - POINT_MUL: operands K, PX, PY → result **PX, PY**.
  - VERIFY: operands PX, PY → **VERIFICATION_RESULT** bit.
  - VERIFY_THEN_POINT_MUL: verify, then (if on-curve) mul → PX, PY.
  - POINT_ADD: P=(PX,PY) affine + Q=(QX,QY,QZ) jacobian → PX,PY (affine
    read) or QX,QY,QZ (jacobian read).
  - MOD_ADD/MOD_SUB: operands PX=a, PY=b → result **PX**.
  - MOD_MUL: operands PX=a, PY=b → result **PY**.
  - INVERSE_MUL: operands PX=num, PY=den → result **PY** = num·den⁻¹
    (modular division), confirmed from `ecc_point_inv_mul` in the test app.
- `components/hal/test_apps/crypto/main/ecc/ecc_params.h` +
  `test_ecc.c` — **the jackpot**: known-answer vectors captured on real
  silicon (`ecc_p256_mul_res_{x,y}`, `ecc_p192_mul_res_*`,
  `ecc256_{add,sub,mul}_res`, `ecc256_inv_mul_res`, etc.). The mod-op test
  does *not* call `set_mod_base`, and `ecc_enable_and_reset` zeroes CONF →
  base defaults to **n** (the test names confirm "order_of_curve").

---

## SÍ funcionó (what worked)

- **Reusing the Phase 2.DI affine EC core verbatim.** The fuzz-verified
  bignum (`bn_t`, base-2³², LE limbs) + affine `ecp_double/ecp_add/ecp_mul`
  + binary-GCD `bn_modinv` carried straight over. Generalized to two
  curves via active-curve globals (`CP/CA/CB/CGX/CGY/CN`, set by
  `ec_select(p256)`); added the curve `b` parameter + `ecp_on_curve`
  (y² ≡ x³+ax+b mod p) for VERIFY, full **P-192** params, and
  `ecp_from_jacobian` (X/Z², Y/Z³) for the jacobian-input modes.
- **Python pre-validation against the silicon vectors** (before writing C):
  a standalone script confirmed every semantic — LE vs BE byte order, mod
  base = n, INVERSE_MUL = num/den mod n, and the Phase 2.DI pubkey link
  (d·G == `798953e7…`). All matched the captured vectors, so the C
  self-test's exact-equality check *is* the validation.
- **Standalone gcc harness** (`tmp_ecc_standalone.c`, math copy-identical):
  caught the aliasing bug (below) and then went 10/10 — a cheap, strong
  pre-build gate.
- **In running QEMU**: all 10 self-test lines green, 10 `ecc` JSON events
  emitted, and the ECDSA peripheral still passes its own self-test
  (no regression). CLIC cause 40 within the 48-line budget (CY).

Self-test results (stderr, verbatim):
```
point_mul P256 x=OK y=OK      point_mul P192 x=OK y=OK
verify valid=OK tampered=OK
mod_add=OK mod_sub=OK mod_mul=OK
inverse_mul=OK
point_add(P+P==2P)=OK
ecdsa-pubkey-link Qx=OK
```

---

## NO funcionó / decisiones (what failed + decisions made)

- **Aliasing bug — `bn_mod(&a, &a, base)`** (real, caught by the harness,
  *not* by the Python pre-check since Python doesn't share the C
  control-flow). `bn_mod(r, a, m)` calls `bn_zero(r)` as its first step;
  when `r == a` the input is wiped before it is read, so MOD_ADD/MOD_SUB
  silently produced garbage (MOD_MUL/INVERSE_MUL were fine — they reduce
  internally without the in-place pre-reduction). **Fix:** reduce operands
  into fresh `ar`/`br` vars. The standalone harness flipped from
  `MOD_ADD/SUB/MUL FAIL` → all OK after the fix; the same fix went into
  `esp32p4_ecc.c`. Lesson: a self-test that only ever compares against an
  external oracle can still miss a bug if the *harness* and the *impl*
  share the buggy line — the independent gcc harness (separate code path)
  is what exposed it.
- **Jacobian modes (4 JACOBIAN_MUL, 6 JACOBIAN_VERIFY, 7
  POINT_VERIFY_JMUL) + POINT_ADD jacobian read-back: not byte-exact.**
  The silicon emits a *particular* Jacobian (X,Y,Z) triple as an internal
  intermediate; that representation is **not canonical** (infinitely many
  (X,Y,Z) map to the same affine point), and reproducing the exact silicon
  triple would require replicating its internal Montgomery/Jacobian
  bookkeeping. **Decision:** compute the correct point and return the
  affine-equivalent with **Z = 1** (affine result exact; intermediate form
  divergent). Justified because mbedtls' `ecp_alt` HW path only consumes
  POINT_MUL / VERIFY_THEN_POINT_MUL / VERIFY — all byte-exact here. The
  POINT_ADD **affine** read path (PX,PY) *is* byte-exact (self-checked
  P+P==2·P vs POINT_MUL by 2). Documented in the source header + the
  README row. Listed in "next" as silicon-exact Jacobian output.
- **Perf:** unchanged from 2.DI — affine ops do one modular inverse per
  point op; binary-GCD keeps POINT_MUL ~0.15-0.25 s/op (fine for a self
  test / occasional guest call). Jacobian coords would batch the inverse
  to one per scalar-mult (~100×) — deferred with the silicon-exact item.

---

## Lessons learned

1. **IDF test apps are a goldmine of silicon-captured KATs.** When a
   peripheral has a `test_apps/.../*_params.h`, those vectors were sampled
   on real hardware → reproducing them byte-for-byte is a far stronger
   oracle than self-consistency or a Python re-derivation. Always grep for
   them first.
2. **Two independent verification paths beat one.** Python (silicon-vector
   oracle) proved the *math*; the standalone gcc harness (separate code
   path, same bug-prone in-place call) proved the *dispatch* and caught the
   aliasing bug Python structurally couldn't. Keep both.
3. **`bn_mod(dst,dst,m)` is unsafe** — `bn_zero(dst)`-first APIs must never
   alias src/dst. Worth an audit of the other `bn_*` self-aliased calls
   (none found in the reused 2.DI core, which always writes to a temp).
4. **The bank-convention table lives in `*_hal.c`, not the reg header.**
   `ecc_hal.c`'s `read_*_result` helpers are the authoritative statement of
   which bank holds each mode's output — the reg header only names the
   banks, not the per-mode routing.

---

## Implementación final (key shape)

- Active-curve model: `ec_select(p256)` loads `CP/CA/CB/CGX/CGY/CN` from
  pre-parsed P-256/P-192 BE constants; point ops reduce mod `CP`; mod-ops
  pick base = `MOD_BASE ? CP : CN`. All banks read/written as 8 words (32
  bytes); P-192's high 8 bytes are 0 (guest pre-clears via
  `clear_param_registers`), so a single 8-word path serves both widths.
- Trigger flow: a write to `CONF` with `START`[0] set runs
  `esp32p4_ecc_compute()` synchronously, sets `INT_RAW.CALC_DONE`, updates
  `VERIFICATION_RESULT`[29], and self-clears `START` — mirroring the
  silicon's "START self-clears when calc is done". `RESET`[1] clears the
  bank/result region. INT raised iff `INT_RAW & INT_ENA & 1`.
- Self-test (`esp32p4_ecc_self_test`, machine-init, needs `event_log`):
  POINT_MUL P-256 + P-192 vs silicon mul_res; VERIFY G (→1) + tampered
  (→0); MOD_ADD/SUB/MUL + INVERSE_MUL (base n) vs silicon vectors;
  POINT_ADD P+P==2·P vs a software 2·G reference; and a cross-link
  POINT_MUL with K = the Phase 2.DI ECDSA key d → pubkey Qx `798953e7…`.

## Estado consolidado (crypto subsystem)

| Periph | Phase | Base | IRQ | Status |
|--------|-------|------|-----|--------|
| AES    | 2.CO  | 0x50090000 | — | real AES-128/256 |
| SHA    | 2.CP+ | 0x50091000 | — | SHA-1/224/256/384/512/512-t (100%) |
| RSA    | 2.DG  | 0x50092000 | 37 | modexp/modmult/mult, fuzz-verified |
| **ECC**| **2.DJ** | **0x50093000** | **40** | **P-256/P-192, silicon-exact** |
| DS     | 2.DH  | 0x50094000 | 38 | HMAC→AES-CBC→MD5→modexp pipeline |
| HMAC   | 2.CM+ | 0x50095000 | — | HMAC-SHA-256, multi-block |
| ECDSA  | 2.DI  | 0x50096000 | 39 | P-256 sign/verify/export |

## Próximas direcciones (next)

- Silicon-exact Jacobian output for ECC/ECDSA (replicate the HW Jacobian
  intermediate) — also gives the ~100× perf win.
- ECDSA from real eFuse ECDSA_KEY block + TRNG-sourced k.
- Secure Boot v2 digest verifier (TRM Cap 29) — consumes ECDSA/SHA.
- DMA controller (unblocks AES-CBC/GCM/XTS + DMA-SHA).
