# Phase 2.BW — TRM-grounded eFuse BLOCK0 + RWDT WDT_DELAY_SEL wiring

**Estado**: ✅ done — replaces Phase 2.BR's hardcoded `const
uint64_t efuse_wdt_delay_sel = 0` with a real read from the
eFuse model. Architecturally now mirrors silicon's eFuse → WDT
dependency.

Per TRM Register 8.5: `EFUSE_WDT_DELAY_SEL` lives in
`EFUSE_RD_REPEAT_DATA1_REG` (offset 0x34) at bits 17:16, with
4 values representing multipliers ×2 / ×4 / ×8 / ×16 applied
to the RWDT stage-0 timeout.

The factory default (un-programmed eFuse, all bits 0) yields
multiplier ×2 — same as Phase 2.BR's hardcoded behavior — so
boot regression-clean.

## Goal

Phase 2.BR implemented the RWDT timeout formula
`Thold0 = STG0_HOLD << (EFUSE_WDT_DELAY_SEL + 1)` with the
DELAY_SEL hardcoded to 0 because we had no eFuse model. Phase
2.BW closes that gap: the eFuse model now stores the field in
its register backing, exposes a public accessor, and machine
init wires LP_WDT to read from it.

Architecturally, this matches silicon's structural dependency:
eFuse fields parameterize peripheral behavior, peripherals
read eFuse at config time. Future eFuse-parameterized fields
(secure boot, key purposes, BLOCK1 MAC + chip rev) can follow
the same accessor pattern.

## Lo que SE INVESTIGÓ

### 1. TRM Register 8.5 — EFUSE_WDT_DELAY_SEL location

Quoted from TRM § 8 (eFuse Controller):

> "EFUSE_WDT_DELAY_SEL Represents RTC watchdog timeout threshold.
>      0: The originally configured STG0 threshold × 2
>      1: The originally configured STG0 threshold × 4
>      2: The originally configured STG0 threshold × 8
>      3: The originally configured STG0 threshold × 16
>      (RO)"

The bit-field diagram shows the field at bits 17:16 of
EFUSE_RD_REPEAT_DATA1_REG (offset 0x34 within the eFuse MMIO
window).

Confirms our Phase 2.BR understanding: the multiplier applied
to STG0_HOLD when computing the RWDT stage-0 timeout.

### 2. Field encoding

Per TRM, the field encodes a *power-of-2 multiplier*:
- value=0 → multiplier=2 (×2)
- value=1 → multiplier=4 (×4)
- value=2 → multiplier=8 (×8)
- value=3 → multiplier=16 (×16)

So formula `Thold0 = STG0_HOLD << (DELAY_SEL + 1)` gives:
- DELAY_SEL=0 → STG0_HOLD << 1 = ×2 ✓ matches TRM
- DELAY_SEL=3 → STG0_HOLD << 4 = ×16 ✓ matches TRM

Our Phase 2.BR formula was already correct; just needed to
wire the actual value from eFuse instead of hardcoding 0.

### 3. eFuse model restructuring

Phase 1's eFuse model had a per-address inline switch returning
hardcoded values:
```c
case 0x0044: return ESP32P4_FAKE_MAC_LO;
case 0x0048: return ESP32P4_FAKE_MAC_HI;
default:     return 0;
```

Phase 2.BW restructures this to use a struct-backed approach:
```c
typedef struct ESP32P4EfuseState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint32_t rd_repeat_data[5];   /* DATA0..DATA4 */
    uint32_t rd_mac_sys[2];       /* MAC_SYS_0/1 */
} ESP32P4EfuseState;
```

Initialized in `realize` with TRM-default values (all zeros for
un-programmed; MAC values for stub). The read handler now
dispatches by register offset to the right backing field.

Forward-extensible: future eFuse fields just need to populate
the right bit positions in the right backing register.

### 4. Public accessor function

Exposed:
```c
uint8_t esp32p4_efuse_get_wdt_delay_sel(ESP32P4EfuseState *s);
```

Returns the 2-bit value (0..3). LP_WDT calls this once at
machine init and snapshots the value. Real silicon reads the
eFuse only at config time (eFuse is read-only after factory
programming), so caching at init is silicon-correct.

### 5. Why machine init snapshot vs runtime read

Considered three approaches:
- **A** Snapshot at machine init (chosen) — clean, matches
  silicon "eFuse is RO" semantics.
- **B** address_space_read() from inside LP_WDT — couples LP_WDT
  to MMIO address space; ugly.
- **C** Direct pointer from LP_WDT state to eFuse state — works
  but adds inter-device coupling.

Snapshot wins: simple, silicon-correct, easy to extend
(LP_WDT gains a `wdt_delay_sel` field, init code does one
read + assignment).

### 6. Field default = 0 preserves behavior

Factory eFuse is un-programmed → all bits 0 → DELAY_SEL=0 →
multiplier ×2 → matches Phase 2.BR's hardcoded behavior.

Boot regression-clean: existing 4-event RTC WDT trace +
0 spurious wdt_reset events confirmed.

To test a non-default multiplier, edit
`s->rd_repeat_data[1]` in `esp32p4_efuse_realize` to set bits
17:16. Or expose via env var in a future phase.

### 7. Backing store size matters for future fields

Five 32-bit DATA registers cover 160 bits of BLOCK0 — enough
for the documented fields in TRM Table 8.3-1 (DIS_TWAI,
DIS_USB_JTAG, KEY_PURPOSE_*, SPI_BOOT_CRYPT_CNT,
WDT_DELAY_SEL, SECURE_BOOT_KEY_REVOKE_*, etc.).

Future phases can add accessors for these without changing the
storage layout.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
0 wdt_reset events
Existing 4-event RTC WDT boot trace unchanged:
  unlock → disable → feed → lock
```

With factory default DELAY_SEL=0, RWDT timing is identical to
Phase 2.BR (×2 multiplier = STG0_HOLD * 2 * 6667 ns).

Architectural verification: machine init reads from eFuse,
LP_WDT uses the snapshotted value. Inspection of code path
confirms the read happens at the right time (eFuse realized
before LP_WDT init).

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Snapshot at init, not runtime**: real silicon reads eFuse
   only at boot. Our snapshot at machine init captures that
   semantic. If someone wanted to test runtime eFuse
   reprogramming behavior, they'd need to add a re-read trigger
   — out of scope.

2. **Factory default = 0 across all fields**: matches
   un-programmed silicon. To exercise non-default values, edit
   the realize function or add env-var support (deferred).

3. **No write path for eFuse**: Phase 1 already ignored writes
   ("eFuse programming is out of scope"). Phase 2.BW maintains
   this — programming would require modeling the PGM/READ
   state machine which is complex and rarely needed for
   demos.

4. **Public accessor instead of QOM property**: cleaner than
   the QOM property pattern for cross-device value passing
   when it happens once at init.

5. **MAC value preserved**: existing fake MAC
   (7C:DF:A1:DE:AD:BE) preserved unchanged via
   `rd_mac_sys[0/1]`. ESP32 OUI 7C:DF:A1 with arbitrary low
   bytes.

6. **No accessors for other fields yet**: only WDT_DELAY_SEL
   accessor in this phase. Future phases that need eFuse
   fields will add similar accessors (e.g.,
   `esp32p4_efuse_get_dis_twai()`, `esp32p4_efuse_get_chip_rev()`).

### Lo que NO funcionó (none caught)

The eFuse refactor was clean — no latent bugs found in the
prior model (it was just minimal, not wrong).

## Lessons learned

1. **eFuse-as-config-source is the silicon-canonical pattern**:
   many peripherals on real silicon are parameterized by eFuse
   fields. Our model now mirrors this structurally — eFuse is
   the source of truth, peripherals snapshot at init.

2. **Snapshot semantics are silicon-correct**: real eFuse is
   read-only post-programming. Init-time snapshot matches.
   No runtime invalidation needed.

3. **Architectural cleanups have value even without behavior
   change**: WDT timing didn't change in this phase (factory
   default DELAY_SEL=0 preserves Phase 2.BR's behavior), but
   the eFuse-to-WDT dependency is now correctly modeled. Future
   tests can flip a single eFuse value and observe the WDT
   timing change accordingly.

4. **TRM Table 8.3-1 lists many BLOCK0 fields**: this phase
   adds infrastructure for one (WDT_DELAY_SEL). Adding more
   becomes a 5-line operation per field (bit positions +
   accessor function).

## Implementación final

### `include/hw/nvram/esp32p4_efuse.h`

- **Added**: register offset macros for DATA0-4 + MAC_SYS_0/1.
- **Added**: `ESP32P4_EFUSE_WDT_DELAY_SEL_SHIFT` (16) +
  `_MASK` macros per TRM Register 8.5.
- **Restructured**: state struct now has `rd_repeat_data[5]`
  + `rd_mac_sys[2]` backing arrays.
- **Added**: `esp32p4_efuse_get_wdt_delay_sel()` accessor.
- TRM citations inline.

### `hw/nvram/esp32p4_efuse.c`

- Read handler dispatches by register offset to the right
  backing field.
- `realize()` initializes backing store with TRM-default
  values (un-programmed = zeros; MAC values preserved).
- New `esp32p4_efuse_get_wdt_delay_sel()` reads bits 17:16
  of DATA1, returns 0..3.

### `include/hw/timer/esp32p4_lp_wdt.h`

- **Added**: `uint8_t wdt_delay_sel` field to LP_WDT state.
- Inline comment cites TRM Register 8.5 + § 17.2.2.2 formula.

### `hw/timer/esp32p4_lp_wdt.c`

- `esp32p4_lp_wdt_stage_timeout_ns()`: uses
  `s->wdt_delay_sel` instead of hardcoded `const = 0`.

### `hw/riscv/esp32p4.c`

- LP_WDT init block: `ms->lp_wdt.wdt_delay_sel =
  esp32p4_efuse_get_wdt_delay_sel(&ms->efuse);` after event_log
  wire, before IRQ wire.

## Estado consolidado (post-2.BW)

eFuse → peripheral dependency wiring:

| eFuse field | TRM reg | Consumer | Wired? |
|-------------|---------|----------|--------|
| WDT_DELAY_SEL | 8.5 bits 17:16 | RWDT (Phase 2.BR) | ✅ **this phase** |
| MAC_FACTORY | 8.9 + 8.10 | (future ESP.getEfuseMac) | available |
| Other BLOCK0 | 8.4-8.8 | (future) | infra ready |

JSON event types: **28** (unchanged — architectural refactor,
no new behavior visible in JSON).

## 60-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BU  | MWDT IRQ→CLIC wiring                                     |
| 2.BV  | RWDT IRQ→CLIC wiring                                     |
| **2.BW** | **eFuse BLOCK0 + RWDT WDT_DELAY_SEL wiring**         |

**10 consecutive TRM-grounded phases (2.BN → 2.BW)**. The
implementation now closely tracks TRM in:
- WDT subsystem (keys, bits, actions, timeouts, multi-stage,
  IRQ, reset — all 4 instances)
- eFuse → WDT dependency (architectural source-of-truth)

## Próximas direcciones

- **More eFuse accessors**: DIS_TWAI, DIS_USB_JTAG, chip_rev,
  KEY_PURPOSE_*, etc.
- **eFuse env-var override** for testing non-default values.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensors.
- **SPI3** instantiation.
- **FreeRTOS** scheduler.
