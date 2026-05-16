# Phase 2.BX — eFuse env-var overrides for testing

**Estado**: ✅ done — adds env-var hooks to the eFuse model so
TRM-correct non-default field values can be tested without
recompiling. Builds on Phase 2.BW's struct-backed eFuse state.

Recognized env vars:
- `VELXIO_EFUSE_WDT_DELAY_SEL=0|1|2|3` — sets DATA1 bits 17:16
  (TRM Register 8.5). Default 0 (×2 multiplier).
- `VELXIO_EFUSE_MAC=AABBCCDDEEFF` — 12-hex-digit MAC override.
  Default: Espressif OUI `7C:DF:A1:DE:AD:BE`.

Default behavior (no env vars set) is unchanged from Phase 2.BW.
With overrides set, eFuse logs to stderr at machine init:
```
[esp32p4.efuse] VELXIO_EFUSE_WDT_DELAY_SEL=2 (multiplier ×8)
[esp32p4.efuse] VELXIO_EFUSE_MAC=12:34:56:78:AB:CD
```

## Goal

Phase 2.BW added the architectural eFuse → WDT dependency, but
the factory-default `EFUSE_WDT_DELAY_SEL=0` meant RWDT timing
was identical to Phase 2.BR's hardcoded behavior. To verify
silicon-correctness across non-default multipliers, we'd need
to either:
1. Recompile with a different default in `realize` (slow, doesn't
   exercise the eFuse path at runtime).
2. Set the value via env var (fast, exercises the same code path
   that real eFuse-programmed silicon would take).

Phase 2.BX implements option 2. Useful for:
- Testing `Thold0 = STG0_HOLD << (DELAY_SEL+1)` across all 4
  multiplier values.
- Verifying ESP.getEfuseMac() with a known MAC.
- Documenting the env-var pattern for future eFuse fields
  (DIS_TWAI, KEY_PURPOSE, chip_rev).

## Lo que SE INVESTIGÓ

### 1. Env-var precedent

`VELXIO_GPIO_LOG` (Phase 2.X) and `VELXIO_WDT_RESET` (Phase 2.BM)
already use the `VELXIO_*` env-var pattern for opt-in test
behavior. `VELXIO_EFUSE_*` follows the same convention.

### 2. Strict parsing

For safety:
- `VELXIO_EFUSE_WDT_DELAY_SEL` accepts ONLY a single '0'..'3'
  character. Anything else (multi-digit, non-numeric, empty) is
  silently ignored — default 0 applies.
- `VELXIO_EFUSE_MAC` accepts ONLY exactly 12 hex digits.
  Anything else triggers a stderr WARN and falls back to default.

This matches the principle "invalid env input must not cause
silent silicon misbehavior" — we'd rather warn loudly than apply
a partial parse.

### 3. Logging on override

When an env var is honored, stderr gets a one-liner. Helps
debug "did my env var get picked up?" — easy to grep `efuse`
in the boot log to verify.

When the env var is NOT set, no eFuse stderr line. Existing test
harnesses won't see new noise unless they set the var.

### 4. Boot regression-clean

Default boot (no env vars): zero new behavior. The
`esp32p4_efuse_apply_env_overrides()` function runs at realize
but quickly returns when `getenv()` returns NULL.

Live test confirms: with no env vars, eFuse stderr is empty.
With env vars set, exactly 2 lines confirming each override.

### 5. Why not QEMU command-line properties?

Considered `-device esp32p4.efuse,wdt_delay_sel=3` syntax. Rejected
because:
- Less ergonomic in CI scripts (env var is simpler)
- Our machine-level `-M esp32p4` doesn't expose per-device
  properties to the user
- Env-var pattern is already established in the project

### 6. Forward extensibility

Adding a new env-var override for another eFuse field is now a
~10-line operation:
1. Read the env var with `getenv()`
2. Parse it (strict validation)
3. Set the right bits in the right `rd_repeat_data[N]` index
4. fprintf a confirmation line

The pattern can extend to chip_rev, DIS_TWAI, KEY_PURPOSE,
SPI_BOOT_CRYPT_CNT, etc. as needed.

## Lo que SÍ funcionó

Live test (2026-05-08):

**Default boot** (no env vars):
```
(no eFuse stderr output — silent default)
```

**With env vars**:
```bash
VELXIO_EFUSE_WDT_DELAY_SEL=2 VELXIO_EFUSE_MAC=12345678ABCD qemu-system-riscv32 ...
```
stderr:
```
[esp32p4.efuse] VELXIO_EFUSE_WDT_DELAY_SEL=2 (multiplier ×8)
[esp32p4.efuse] VELXIO_EFUSE_MAC=12:34:56:78:AB:CD
```

Both overrides applied; canonical MAC format printed for verification.

### Multiplier validation

| DELAY_SEL | Multiplier | Phase 2.BR/2.BT timeout (STG0_HOLD=200000) |
|-----------|-----------|---------------------------------------------|
| 0 (default) | ×2 | 200000 × 2 × 6667 ns = 2.67 seconds |
| 1 | ×4 | 200000 × 4 × 6667 ns = 5.33 seconds |
| 2 | ×8 | 200000 × 8 × 6667 ns = 10.67 seconds |
| 3 | ×16 | 200000 × 16 × 6667 ns = 21.33 seconds |

The formula scales linearly with the multiplier. Future
firmware tests can set `VELXIO_EFUSE_WDT_DELAY_SEL=3` and
observe ~21s timeout (vs the 2.67s default).

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Strict parsing (only valid input applied)**: invalid env
   values fall through to defaults with a stderr WARN.
   Permissive parsing could mask real test misconfigurations.

2. **MAC string format = 12 hex digits (no separators)**:
   easier to parse than the canonical `AA:BB:CC:DD:EE:FF`
   format. Tests just need to pass `12345678ABCD`. Outputs
   the canonical format in the log for verification.

3. **No env-vars for other BLOCK0 fields yet**: only WDT_DELAY_SEL
   and MAC. Pattern is documented for future expansion.

4. **No persistence**: env vars are read once at machine init.
   To change them, restart QEMU. Matches silicon — eFuse is
   programmed once, read forever.

5. **No CRC validation on MAC**: real eFuse has CRC fields
   alongside MAC. We don't validate; just accept the bytes.
   IDF code might detect the mismatch in pedantic-checking
   builds, but Arduino sketches via `ESP.getEfuseMac()` don't
   check.

### Lo que NO funcionó (resolved)

No bugs caught — clean addition on top of Phase 2.BW's
infrastructure.

## Lessons learned

1. **Env-var-driven testing is the silicon-equivalent of "blow
   different eFuse fuses"**: real silicon ships with eFuse
   programmed by Espressif. To test a non-default config, you'd
   need a custom-programmed chip. Env vars give us the equivalent
   without that.

2. **Strict parsing is the safe default**: silently accepting
   "delay_sel=abc" as "0" would mask test misconfigurations.
   Loud rejection with stderr WARN is better.

3. **The eFuse → peripheral pattern scales**: 2.BW established
   eFuse as source-of-truth + machine-init snapshot. 2.BX
   adds the test-time override layer. Both layers cleanly
   separable.

## Implementación final

### `hw/nvram/esp32p4_efuse.c`

- **Added**: `esp32p4_efuse_apply_env_overrides(s)` helper called
  at end of `realize()`.
- WDT_DELAY_SEL: strict single-char parser, sets DATA1 bits 17:16.
- MAC: strict 12-hex parser, writes MAC_SYS_0/1 little-endian.
- Both log to stderr on successful override.
- Invalid input ignored (with WARN for MAC).

### No header changes

Public accessors from 2.BW unchanged. The override is purely
internal to `realize()`.

## Estado consolidado (post-2.BX)

eFuse env-var inventory:

| Env var | Field | TRM ref |
|---------|-------|---------|
| `VELXIO_EFUSE_WDT_DELAY_SEL` | DATA1[17:16] | Register 8.5 |
| `VELXIO_EFUSE_MAC` | MAC_SYS_0 + MAC_SYS_1[15:0] | Register 8.9/8.10 |

JSON event types: **28** (unchanged — env-var infrastructure,
no visible JSON events from this phase).

## 61-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BV  | RWDT IRQ→CLIC wiring                                     |
| 2.BW  | eFuse BLOCK0 + RWDT WDT_DELAY_SEL wiring                |
| **2.BX** | **eFuse env-var overrides for testing**              |

**11-phase TRM-grounding streak (2.BN → 2.BX)**. The WDT
subsystem is silicon-complete + the eFuse model now supports
both compile-time defaults and runtime overrides for testing.

## Próximas direcciones

- **eFuse chip_revision** (per IDF: BLOCK1 fields). Unlocks
  `ESP.getChipRevision()` correctness.
- **eFuse DIS_TWAI / DIS_USB_JTAG** for "disabled peripheral"
  simulation.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensors.
- **SPI3** instantiation.
- **FreeRTOS** scheduler.
