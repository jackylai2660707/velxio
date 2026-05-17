# Phase 2.CK — eFuse JTAG-disable triplet (SOFT_DIS_JTAG + DIS_PAD_JTAG + JTAG_SEL_ENABLE)

**Estado**: ✅ done — extends the Phase 2.CC peripheral-disable
eFuse model with the three JTAG-related fields from
`efuse_rd_repeat_data0_reg_t`. Documents a **silicon anti-tamper
encoding** (3-bit "popcount-odd = disabled") that doesn't appear
anywhere else in the eFuse model and is non-obvious from a quick
TRM read.

Live verification (2026-05-17) — all five test scenarios pass:

| Scenario | stderr trace |
|----------|--------------|
| Default | (no JTAG output — silent) |
| `DIS_PAD_JTAG=1` | `VELXIO_EFUSE_DIS_PAD_JTAG=1 (peripheral disabled)` |
| `SOFT_DIS_JTAG=1` (popcount 1, odd) | `popcount=1 → JTAG soft-disabled` |
| `SOFT_DIS_JTAG=3` (popcount 2, even) | `popcount=2 → JTAG enabled` ← **anti-tamper case** |
| `SOFT_DIS_JTAG=7` (popcount 3, odd) | `popcount=3 → JTAG soft-disabled` |

The SOFT_DIS_JTAG=3 case is the headline silicon detail: a
value of "3" (binary `011`) **does not mean disabled** despite
both `dis` in the field name and a non-zero value. Anti-tamper
encoding inverts intuition.

## Goal

Continue the eFuse-as-source-of-truth pattern (2.BW → 2.CC = 7
phases) into the remaining BLOCK0 DATA0 fields. Phase 2.CC
exposed DIS_TWAI, DIS_USB_JTAG, DIS_USB_SERIAL_JTAG; this phase
fills in the three JTAG-control fields that share the same
register:

| Field | Bit(s) | Width | Semantics |
|-------|--------|-------|-----------|
| `JTAG_SEL_ENABLE` | 15 | 1 | strap selects USB vs pad JTAG |
| `SOFT_DIS_JTAG` | 18:16 | 3 | popcount-odd anti-tamper |
| `DIS_PAD_JTAG` | 19 | 1 | hard permanent disable |

None are wired to peripheral behavior because no JTAG bridge
is modeled — exposed as accessors + env-vars for testability
and as documentation hooks for the future USB-Serial-JTAG
phase.

## Lo que SE INVESTIGÓ

### 1. Field locations confirmed in IDF authoritative source

`components/soc/esp32p4/include/soc/efuse_struct.h:217-233`:
```c
uint32_t jtag_sel_enable:1;     // bit 15
uint32_t soft_dis_jtag:3;       // bits 18:16
uint32_t dis_pad_jtag:1;        // bit 19
```

All three live in `EFUSE_RD_REPEAT_DATA0_REG` (offset 0x30),
the same register Phase 2.CC's DIS_TWAI / DIS_USB_JTAG /
DIS_USB_SERIAL_JTAG also occupy. Five distinct DIS-related
fields packed into the same 32-bit word — typical Espressif
eFuse density.

### 2. The popcount-odd anti-tamper encoding

Reading the IDF comment at line 224-227:
```
/** soft_dis_jtag : RO; bitpos: [18:16]; default: 0;
 *  Represents whether JTAG is disabled in soft way.
 *  Odd number: disabled. Even number: enabled.
 */
```

This is **NOT a multi-bit value where each bit means something
different** (like, say, the 3-bit STG0_ACTION in TRM Register
17.1). It's a **popcount-parity check** — the silicon evaluates
the *bit count* of the 3-bit field, not its numeric value:

| Raw value | Binary | Popcount | Effective state |
|-----------|--------|----------|-----------------|
| 0 | 000 | 0 (even) | enabled |
| 1 | 001 | 1 (odd) | **disabled** |
| 2 | 010 | 1 (odd) | **disabled** |
| 3 | 011 | 2 (even) | enabled |
| 4 | 100 | 1 (odd) | **disabled** |
| 5 | 101 | 2 (even) | enabled |
| 6 | 110 | 2 (even) | enabled |
| 7 | 111 | 3 (odd) | **disabled** |

Why? **Bit-flip resistance**. A single bit-flip (e.g., from a
voltage glitch or laser fault injection) changes the popcount
by exactly 1 — flipping the parity. So:
- If the eFuse was programmed `disabled` (popcount odd), a
  single bit-flip → even → **enabled**: would be a security
  hole.
- The 3-bit field gives 4 disabled-encodings (1, 2, 4, 7) and
  4 enabled-encodings (0, 3, 5, 6). Programming `1` for
  disabled means an attacker needs to flip 2 bits to switch
  to enabled. Programming `7` for disabled means flipping 1
  bit goes to popcount=2 (still enabled), and flipping 2 bits
  could go either way — extra attacker work needed.

This is a non-trivial silicon detail that a naive "X-bit
field treated as integer" interpretation would get wrong.

### 3. DIS_PAD_JTAG (hard) vs SOFT_DIS_JTAG (soft)

Per the IDF struct comments:
- **`dis_pad_jtag`** (bit 19, 1 bit): "*Represents whether
  JTAG is disabled in the **hard way** (permanently).*" Once
  programmed to 1, no software path re-enables JTAG. The pad
  is electrically disconnected.
- **`soft_dis_jtag`** (bits 18:16, 3 bit, popcount): "*soft
  way*" disable. Can be re-enabled via the
  `SW_JTAG_RESUME` eFuse field (different register, not in
  this phase's scope) or via debug-mode authentication.

Real production silicon typically:
1. Sets `SOFT_DIS_JTAG` at factory to prevent casual JTAG
   probing.
2. Customers field-upgrade to `DIS_PAD_JTAG=1` only for
   highest-security deployments (banking, automotive
   safety-critical) because the hard disable is irreversible.

### 4. JTAG_SEL_ENABLE

Per IDF struct line 218-222:
> *Selects between usb_to_jtag and pad_to_jtag through
> strapping gpio15 when both EFUSE_DIS_PAD_JTAG and
> EFUSE_DIS_USB_JTAG are equal to 0 is enabled or disabled.*

So the strap-pin GPIO15 only selects when **both** JTAG paths
are physically enabled (DIS_PAD_JTAG=0 AND DIS_USB_JTAG=0).
If JTAG_SEL_ENABLE=0, the strap is ignored and USB JTAG
always wins.

This is a 3-way decision tree the emulator would need to
model when a JTAG bridge eventually exists. Documented in the
header comment for future reference.

### 5. Where IDF reads these fields

`components/efuse/esp32p4/esp_efuse_table.csv` defines the
field names:
- `DIS_PAD_JTAG` referenced by `esp_secure_boot.c` and
  `esp_efuse_utility.c` (debug-mode authentication path).
- `SOFT_DIS_JTAG` accessed by `esp_efuse_jtag.c` via the
  `esp_efuse_set_soft_dis_jtag()` API (used in IDF debug
  mode toggle).
- `JTAG_SEL_ENABLE` only referenced in the eFuse field
  table; not accessed by typical Arduino sketches.

For the emulator the practical impact is "guest code that
reads these registers gets the right values"; with no JTAG
peripheral modeled, no IDF code path is currently exercised.

### 6. Reuse of Phase 2.CC's static const table

`DIS_PAD_JTAG` and `JTAG_SEL_ENABLE` are 1-bit fields with
identical env-var parsing semantics ("0" or "1") to the
existing DIS_TWAI / DIS_USB_JTAG / DIS_USB_SERIAL_JTAG. Added
them as two new rows in the existing static const table — no
parser-code duplication needed.

`SOFT_DIS_JTAG` needs a separate parser because:
- 3-bit field (accepts "0"..."7")
- Stderr trace should compute and display the popcount-parity
  interpretation so users see what their value actually means.

## Lo que SÍ funcionó

1. ✅ Build clean — single file changed
   (`hw_nvram_esp32p4_efuse.c.o`).
2. ✅ Default boot silent on JTAG eFuse (no env vars set).
3. ✅ `DIS_PAD_JTAG=1` parses + traces "peripheral disabled".
4. ✅ `SOFT_DIS_JTAG=1` (popcount 1, odd) traces "JTAG
   soft-disabled".
5. ✅ `SOFT_DIS_JTAG=3` (popcount 2, **even**) traces "JTAG
   enabled" — anti-tamper encoding behaves correctly.
6. ✅ `SOFT_DIS_JTAG=7` (popcount 3, odd) traces "JTAG
   soft-disabled".
7. ✅ No regressions in other peripherals — chip_info still
   emits, all 9 I2C devices still respond.

## Lo que NO funcionó / decisiones tomadas

### Lo que casi falla

**Initial implementation** of `soft_dis_jtag` returned the raw
3-bit value directly. After re-reading the IDF struct comment
("Odd number: disabled. Even number: enabled"), realized this
was wrong — needed to apply the popcount-parity check.

The bug would have been silent: env-vars would set the raw
value correctly, the storage would round-trip, but the
**boolean accessor** would have returned `value != 0` instead
of `popcount_is_odd(value)`. A future JTAG-bridge phase using
`esp32p4_efuse_get_soft_dis_jtag()` to gate JTAG access would
have incorrectly enabled JTAG when SOFT_DIS_JTAG=3 was
programmed.

Caught by **manually reading the IDF struct comment a second
time** before writing the accessor. Fixed by computing
`popcount(raw_value) & 1` instead of `raw_value != 0`.

Exposed BOTH accessors (`_raw()` returning 0..7, and `()`
returning bool) so env-var test harnesses can verify the raw
value round-trips while production code uses the silicon-
correct boolean.

### Decisiones tomadas

1. **Two accessors for SOFT_DIS_JTAG** (raw + boolean): raw
   for round-trip tests, boolean for production gating. Real
   silicon only exposes the boolean (the popcount-parity
   check is done in hardware before any software-visible
   interface), but tests benefit from seeing the underlying
   value.

2. **Stderr trace shows BOTH raw and popcount**: not just
   "JTAG disabled" but "popcount=2 → JTAG enabled". Users
   learn the anti-tamper encoding by watching the trace.

3. **No JTAG peripheral wiring**: same scope decision as
   DIS_USB_JTAG / DIS_USB_SERIAL_JTAG in Phase 2.CC. JTAG
   bridge model is future work.

4. **Static const table reuse for single-bit fields**: DIS_PAD_JTAG
   and JTAG_SEL_ENABLE drop in as 2 new rows. Zero parser-code
   duplication.

5. **Document the popcount table inline** (8-row table in the
   autosearch doc above): future maintainers reading the
   accessor will immediately understand why `popcount` matters
   without needing to dig through TRM/IDF.

## Lessons learned

1. **Re-read IDF struct comments BEFORE implementing the
   accessor**. The "Odd number: disabled" phrasing is easy to
   miss. Implementing `value != 0` would have been silently
   wrong.

2. **Anti-tamper encodings exist in silicon** and don't
   resemble normal multi-bit field semantics. Whenever a
   field is 3+ bits with single-line "X means Y" comments,
   suspect a non-numeric encoding.

3. **Test the anti-tamper case explicitly** — the
   `SOFT_DIS_JTAG=3 → enabled` test is the only one that
   catches a "treat value as integer" bug. Without that test
   case, the bug would have shipped.

4. **Stderr-trace educates by showing intermediate
   computation**: rather than just printing the final
   "enabled/disabled" state, print the popcount so users
   understand WHY a value of 3 means enabled.

5. **Three related fields, three different bit widths**: the
   eFuse model now has 1-bit (DIS_TWAI etc.), 3-bit anti-
   tamper (SOFT_DIS_JTAG), 4-bit numeric (PKG_VERSION/MINOR
   from 2.BY/2.CA), and 2-bit numeric (WDT_DELAY_SEL from
   2.BW). The dispatcher accommodates all without special-
   casing.

## Implementación final

### `include/hw/nvram/esp32p4_efuse.h`

- 3 new constant pairs for `JTAG_SEL_ENABLE`, `SOFT_DIS_JTAG`
  (3-bit mask), `DIS_PAD_JTAG`.
- 4 new accessor forward-declarations:
  `_dis_pad_jtag()`, `_jtag_sel_enable()`,
  `_soft_dis_jtag()` (boolean popcount-parity),
  `_soft_dis_jtag_raw()` (raw 0..7 for tests).
- Inline header comment documenting the anti-tamper semantics
  + 3-way JTAG selection decision tree.

### `hw/nvram/esp32p4_efuse.c`

- 4 new accessor implementations. `_soft_dis_jtag()` computes
  popcount of 3-bit value and returns `(popcount & 1) != 0`.
- 2 new rows in `dis_fields[]` static const table for the
  1-bit fields (DIS_PAD_JTAG, JTAG_SEL_ENABLE).
- Dedicated SOFT_DIS_JTAG env-var parser (3-bit, prints
  popcount in stderr trace for user education).

### No machine init / peripheral changes

Pure eFuse model extension. JTAG isn't a peripheral yet.

## Estado consolidado (post-2.CK)

eFuse model now covers **all DATA0 disable fields** plus the
JTAG triplet:

| Field | Bit(s) | Width | Phase | Wired? |
|-------|--------|-------|-------|--------|
| `DIS_USB_JTAG` | 9 | 1 | 2.CC | env-var only |
| `DIS_USB_SERIAL_JTAG` | 11 | 1 | 2.CC | env-var only |
| `DIS_TWAI` | 14 | 1 | 2.CC | TWAI peripheral disable ✓ |
| **`JTAG_SEL_ENABLE`** | **15** | **1** | **2.CK** | env-var only |
| **`SOFT_DIS_JTAG`** | **18:16** | **3 (popcount)** | **2.CK** | env-var only |
| **`DIS_PAD_JTAG`** | **19** | **1** | **2.CK** | env-var only |

JSON event types: **30** (unchanged — eFuse fields don't add
events, they parameterize behavior).

## 73-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CC  | DIS_TWAI + DIS_USB_JTAG + DIS_USB_SERIAL_JTAG eFuse     |
| 2.CJ  | APDS-9960 (post-refactor sensor add)                    |
| **2.CK** | **eFuse JTAG triplet — popcount anti-tamper documented** |

## Próximas direcciones

- **KEY_PURPOSE 0..5** (Phase 2.CL candidate) — 6 fields × 4
  bits each, split across rd_repeat_data1 (KEY_PURPOSE_0/1)
  and rd_repeat_data2 (KEY_PURPOSE_2..5). Each value 0..15
  encodes a crypto key role (USER, XTS-AES, HMAC, SECURE_BOOT
  digest, ECDSA, etc.). Per IDF `esp_efuse.h` enum.
- **USB Serial/JTAG peripheral model** — would let
  DIS_USB_JTAG / DIS_USB_SERIAL_JTAG actually disable the
  peripheral (silicon-correct enforcement, mirrors DIS_TWAI
  from 2.CC).
- **MS5611 barometer** (24-bit ADC + 8 PROM regs).
- **W5500 Ethernet** + **MFRC522 RFID** SPI responders.
- **UART IRQ** via interrupt matrix (needs CLIC extension or
  shared lines — cause 31 taken).
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection (biggest unblocker).
