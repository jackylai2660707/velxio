# Phase 2.BP — RWDT stage-0 action decoding per TRM

**Estado**: ✅ done — mirrors Phase 2.BO for the LP_WDT block.
Decodes the 3-bit `RTC_WDT_STG0` action field from CONFIG0 bits
30:28 per TRM Register 17.1 with 5 action codes (vs MWDT's 4).

Per TRM Register 17.1:
```
RTC_WDT_STG0 action codes (3-bit field):
  0 = No operation
  1 = Generate interrupt
  2 = Generate HP CPU reset
  3 = Generate HP core reset
  4 = Generate system reset (RWDT-only — TRM Table 17.2-1)
```

JSON events now reflect the actual action — `wdt_irq` for code=1,
`wdt_reset` with `action:"rst_cpu"` / `"rst_hp_core"` / `"rst_sys"`
for the reset variants. The `qemu_system_reset_request()` call is
gated on action ∈ {2, 3, 4} AND `VELXIO_WDT_RESET=1`.

Boot regression-clean: 0 wdt_reset, 0 wdt_irq, existing 4-event
RTC WDT trace (unlock → disable → feed → lock) unchanged.

## Goal

Phase 2.BN's LP_WDT reset behavior was approximate — fired a
generic `wdt_reset` event regardless of the configured action.
TRM Register 17.1 shows the action field is 3 bits with 5 codes,
including "Generate system reset" at value 4 (an RWDT-specific
action; MWDT's action set tops out at 3).

Phase 2.BP closes the gap with TRM-correct decoding. Companion
to Phase 2.BO which did the same for TIMG MWDT.

## Lo que SE INVESTIGÓ

### 1. TRM Register 17.1 — RTC_WDT_CONFIG0_REG bit layout

Read directly from TRM ESP32-P4 v0.5 chapter 17, Register 17.1:

```
bit 31:    RTC_WDT_EN            (1=enabled)
bits 30:28: RTC_WDT_STG0         (3-bit action — NOTE 3 bits, not 2)
bits 27:25: RTC_WDT_STG1
bits 24:22: RTC_WDT_STG2
bits 21:19: RTC_WDT_STG3
bits 18:16: RTC_WDT_CPU_RESET_LENGTH (3 bits)
bits 15:13: RTC_WDT_SYS_RESET_LENGTH
... (other config bits — PAUSE_IN_SLP, FLASHBOOT_MOD_EN,
     PROCPU_RESET_EN at various reserved-area positions)
```

**Key difference from MWDT (TRM Register 16.10)**:
- MWDT: 2-bit stage fields, 4 action codes (max = "Reset system" = 3)
- **RWDT: 3-bit stage fields, 5 action codes (max = "System reset" = 4)**

RWDT's value 3 means "Generate HP core reset" (an intermediate
between CPU-only reset and full system reset). MWDT doesn't have
this — its action set only has CPU reset and system reset.

This means our Phase 2.BN hardcoded behavior was effectively
treating ANY enable as "system reset" which would happen to be
correct only if the guest set STG0=4. For other values (intr,
rst_cpu, rst_hp_core, none) the behavior was wrong.

### 2. Action set comparison MWDT vs RWDT

| Code | MWDT (TRM 16.10) | RWDT (TRM 17.1) |
|------|------------------|------------------|
| 0 | No effect | No operation |
| 1 | Interrupt | Generate interrupt |
| 2 | Reset CPU | Generate HP CPU reset |
| 3 | Reset system | **Generate HP core reset** |
| 4 | (not valid) | **Generate system reset** |

So MWDT's code 3 ≠ RWDT's code 3. This is a critical disambiguator
that's only obvious from reading both registers side-by-side.

Documented inline in both `esp32p4_timg.h` (MWDT) and
`esp32p4_lp_wdt.h` (RWDT) so future maintainers can't confuse
them.

### 3. "HP core reset" vs "System reset" — our model

Real silicon distinguishes:
- HP CPU reset: just resets CPU0 + CPU1
- HP core reset: resets CPU + HP peripherals + HP GPIO
- System reset: resets HP core + LP system + everything

For our model, all three of these result in
`qemu_system_reset_request()` — we don't differentiate the reset
scopes. JSON event includes the action name so frontend can
render different visuals; the actual reset behavior is the same.

This is a deliberate simplification documented in the inline
comments.

### 4. Boot safety: unchanged

Boot self-test writes `CONFIG0 = 0` (EN=0, STG0=000=NONE). Timer
doesn't arm (EN=0). Even if it did, action=NONE means "no
operation" → JSON event but no actual action. Safe.

Live test confirms: 0 wdt_reset, 0 wdt_irq at boot.

### 5. WDT inventory consistency

After both Phase 2.BO (MWDT) and Phase 2.BP (RWDT), the action-
decoding is uniform:
- TIMG0 WDT: STG0 from CONFIG0[30:29] (2-bit, 4 codes)
- TIMG1 WDT: same as TIMG0 (shared class)
- RTC WDT: STG0 from CONFIG0[30:28] (3-bit, 5 codes)
- Super WDT: no per-stage actions (always system reset on
  timeout per TRM § 17.3)

3/4 WDTs decode action codes; SWD doesn't need to (single fixed
action).

## Lo que SÍ funcionó

Live test (2026-05-08):
```
Existing 4-event RTC WDT boot trace unchanged:
  unlock → disable → feed → lock

wdt_reset count: 0
wdt_irq   count: 0
```

The new code path is exercised by construction. Live behavior
won't change until firmware enables RWDT with a non-zero STG0
under unlock.

To trigger the new behavior, a sketch would write:
```c
*(volatile uint32_t*)0x50116018 = 0x50D83AA1;  // unlock
*(volatile uint32_t*)0x50116000 = (1<<31) | (4<<28);  // EN + STG0=rst_sys
// don't feed for 5 seconds
```
And with `VELXIO_WDT_RESET=1` set, the chip would reboot.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **All reset codes map to the same `qemu_system_reset_request`**:
   real silicon differentiates CPU reset, HP core reset, system
   reset. We don't. JSON event names distinguish; actual
   behavior is uniform reset.

2. **wdt_irq event with `grp:"rtc"` differentiates from TIMG**:
   Phase 2.BO's wdt_irq for TIMG uses `grp:0` or `grp:1` (group
   number). RWDT uses `grp:"rtc"` (string). Frontend can
   distinguish by inspecting the grp type or value.

3. **No IRQ-action CLIC wiring this phase**: action=1 emits
   wdt_irq event but doesn't pulse a CPU IRQ line. Real silicon
   routes RWDT IRQ to the LP-side interrupt controller. Our
   model doesn't yet wire LP IRQs (deferred as `2.BP.lp-irq`).

4. **Multi-stage still deferred**: stages cycle 0→1→2→3→0 on
   consecutive timeouts per TRM § 17.2.2.2. Our model fires
   stage 0 then stops. Multi-stage deferred for both MWDT
   (Phase 2.BO) and RWDT (this phase) as `2.BP.multistage`.

5. **Stages 1-3 actions not decoded**: only STG0 is captured.
   For multi-stage support, all 4 STG fields would need
   decoding. Trivial extension when multi-stage is added.

## Lessons learned

1. **Reading register diagrams side-by-side catches confusion**:
   MWDT and RWDT both have "STG0" action fields but different
   widths and code sets. Easy to confuse if you only look at
   one. Side-by-side TRM Register 16.10 + 17.1 comparison made
   the differences clear.

2. **Inline TRM citations prevent future confusion**: every
   action code constant in our header now cites the TRM
   register + code value. A future maintainer adding code 4 to
   MWDT (by analogy with RWDT) would see immediately that
   MWDT's code 4 is "not valid".

3. **The Phase 2.BO recipe replicated cleanly to LP_WDT**:
   ~50 lines of code, mostly mechanical copy-paste with the
   key differences (3-bit field, 5 codes, different reset
   semantics) preserved. The pattern is now stable.

4. **Approximation vs TRM correctness has a cost**: Phase
   2.BN's "always system reset" worked for the common case
   (Arduino default action=4) but would have silently
   misbehaved if a sketch set action=1 (intr-only, no reset).
   Phase 2.BP fixes this for RWDT just as 2.BO fixed it for
   MWDT.

## Implementación final

### `include/hw/timer/esp32p4_lp_wdt.h`

- **Added**: full TRM Register 17.1 bit-layout comment.
- **Added**: `ESP32P4_LP_WDT_STG0_SHIFT` (28),
  `ESP32P4_LP_WDT_STG0_MASK` (0x7 << 28),
  `ESP32P4_LP_WDT_STG0(v)` decode macro.
- **Added**: 5 action code constants (NONE, INTR, RST_CPU,
  RST_HP_CORE, RST_SYS).
- **Added**: `uint8_t rwdt_stg0_action;` to ESP32P4LpWdtState.
- Documents MWDT vs RWDT differences inline (3-bit vs 2-bit,
  5 codes vs 4).

### `hw/timer/esp32p4_lp_wdt.c`

- CONFIG0 write handler: extracts STG0 action via
  `ESP32P4_LP_WDT_STG0(v)` and stores in
  `s->rwdt_stg0_action`. Stderr now logs the action code.
- `esp32p4_lp_wdt_rwdt_reset_cb()`: switch dispatches on
  `s->rwdt_stg0_action`:
  - 0 → emit wdt_reset with `action:"none"`, no reset.
  - 1 → emit wdt_irq with `grp:"rtc"`, no reset.
  - 2 → emit wdt_reset with `action:"rst_cpu"`, conditional reset.
  - 3 → emit wdt_reset with `action:"rst_hp_core"`, conditional reset.
  - 4 → emit wdt_reset with `action:"rst_sys"`, conditional reset.
- Reset call only for action ∈ {2,3,4} + env var opt-in.

## Estado consolidado (post-2.BP)

WDT action decoding inventory:

| WDT | Phase | Field width | Codes | Decoded? |
|-----|-------|-------------|-------|----------|
| TIMG0 WDT | 2.BO | 2 bits (30:29) | 4 (0-3) | ✓ |
| TIMG1 WDT | 2.BO | 2 bits (shared) | 4 | ✓ |
| **RTC WDT** | **2.BP** | **3 bits (30:28)** | **5 (0-4)** | **✓** |
| Super WDT | n/a | no stages | fixed action | n/a |

JSON event types: **27** (unchanged from 2.BO — RWDT just adds
more variants of the existing wdt_reset and wdt_irq events).

## 53-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BN  | RTC/SWD reset + TRM key fix                              |
| 2.BO  | MWDT stage-0 action decode (4 codes)                     |
| **2.BP** | **RWDT stage-0 action decode (5 codes incl. sys reset)** |

## Próximas direcciones

- **Multi-stage WDT progression** (both MWDT + RWDT) — stages
  cycle 0→1→2→3→0 with independent timeouts + actions per TRM
  § 17.2.2.2.
- **WDT IRQ→CLIC wiring**: action=1 should actually pulse a
  CPU IRQ line. For MWDT route via existing TIMG IRQ (causes
  19/20). For RWDT need an LP-side IRQ route (new).
- **TRM-correct timeout** from CONFIG1/CONFIG2 instead of
  hardcoded 5s/1s.
- **UART IRQ** (QOM class-override variation).
- **Real PWM waveform** on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensor adds.
- **SPI3** instantiation.
- **FreeRTOS** scheduler resurrection.
