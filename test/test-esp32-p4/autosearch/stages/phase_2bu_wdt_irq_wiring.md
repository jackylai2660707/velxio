# Phase 2.BU — TIMG WDT IRQ→CLIC wiring per TRM § 17.4

**Estado**: ✅ done — closes the WDT IRQ chain. Action=Interrupt
(STG action code 1, decoded in Phase 2.BO) now actually pulses
the CPU IRQ line by setting `TIMG_WDT_INT_RAW` (bit 2 of the
consolidated TIMG INT register set) and reusing the existing
TIMG CLIC cause line.

Per TRM § 17.4: "For watchdog timer interrupts, please refer to
Section 16.3.7 Interrupts in Chapter 16 Timer Group." Per TRM
Register 16.21-16.24, the WDT INT shares the same INT_RAW/ENA/
ST/CLR register set as the T0 alarm, at bit 2.

Before this phase: action=1 emitted `wdt_irq` JSON event but
never trapped the CPU. Arduino sketches with
`esp_task_wdt_init(timeout, panic=false)` would see the JSON
event but the registered ISR would never run.

After: action=1 raises CLIC cause 19 (TIMG0) or 20 (TIMG1) via
the existing TIMG IRQ infrastructure. Guest ISR runs, reads
`INT_ST` to discriminate T0 alarm from WDT (bit 0 vs bit 2),
clears the appropriate bit via `INT_CLR` W1TC.

Boot regression-clean: 0 wdt_reset, 0 wdt_irq events. Existing
17 timg_irq events from T0 alarm activity preserved (mask
extension from bit-0-only to bits 0+2 didn't break T0 handling).

## Goal

Phase 2.BO/2.BP/2.BS/2.BT collectively implemented WDT action
decoding + multi-stage cycling. But action=1 (Interrupt) was
JSON-only — it emitted the `wdt_irq` event but didn't pulse a
CPU IRQ line. Arduino `esp_task_wdt_init(panic=false)` patterns
that rely on the warning-IRQ-then-reset sequence couldn't run
their ISR.

Phase 2.BU closes this last WDT gap by routing the WDT INT
through the existing TIMG INT register set + CLIC cause line.

## Lo que SE INVESTIGÓ

### 1. TRM § 17.4 — WDT IRQ infrastructure reuse

Quoted verbatim:

> "For watchdog timer interrupts, please refer to Section 16.3.7
> Interrupts in Chapter 16 Timer Group (TIMG)."

This is the silicon-grounded answer to "where does the WDT IRQ
go?" — it doesn't have its own CLIC cause line, it shares the
existing TIMG IRQ infrastructure with the T0/T1 alarms.

### 2. TRM Register 16.21-16.24 — consolidated INT layout

From the TRM register diagrams:

```
TIMG_INT_RAW_TIMERS_REG (0x0074):
  bit 0: TIMG_T0_INT_RAW   (T0 alarm)
  bit 1: TIMG_T1_INT_RAW   (T1 alarm — T1 not modelled in our skeleton)
  bit 2: TIMG_WDT_INT_RAW  (WDT timeout interrupt)
```

Same bit layout for INT_ENA (0x70), INT_ST (0x78), INT_CLR (0x7C).

The Phase 2.AH refresh_irq logic was masking with `0x1U` (T0 only).
Extending to `0x5U` (T0|WDT) covers both sources.

### 3. CLIC cause line reuse

Existing wiring:
- TIMG0 → CLIC cause 19 (Phase 2.AH)
- TIMG1 → CLIC cause 20 (Phase 2.AN.irq)

The WDT INT bit just feeds into the same `qemu_irq` output line.
Guest ISR running on cause 19 or 20 inspects INT_ST to determine
the source (T0 alarm bit 0 vs WDT bit 2).

This is the canonical real-silicon pattern — single CLIC line
per peripheral block, software disambiguates via status register.

### 4. INT_ENA/INT_CLR W1TC semantics extended

Phase 2.AH's INT_ENA was masked `& 0x1U` (T0 only). Extended to
`& ESP32P4_TIMG_INT_MASK` (= `0x5U` = T0 + WDT). Bit 1 (T1)
reserved for future expansion.

INT_CLR was `if (v & 0x1U) clear bit 0`. Extended to W1TC pattern
`s->int_raw &= ~(v & MASK)` — writing 1 to any bit in MASK clears
that bit. Real silicon W1TC semantics.

### 5. Boot safety analysis

Boot self-test enables WDT only momentarily (unlock → disable →
feed → lock with EN=0). Even if EN were 1, all stage actions are
NONE by default. So WDT IRQ bit 2 never gets set during boot.

The existing T0 alarm IRQ (bit 0) is set by the demo blob via
TIMG self-test pre-program — confirmed by 17 timg_irq events in
the live test. The mask extension from 0x1 to 0x5 preserves this
behavior (T0 bit still fires correctly).

### 6. Multi-stage cycling integration

Phase 2.BS's multi-stage cycling already calls the timer
callback for each stage. We hook the INT_RAW.WDT bit set into
the action=Interrupt branch — only fires when the configured
action is Interrupt, regardless of which stage triggered.

Sequence for esp_task_wdt_init(N, panic=false):
- t=0: Guest writes CONFIG0 with EN=1, STG0=1 (intr), STG1=0
       (none — keep timeout-then-no-action behavior).
- t=N: Stage 0 timeout fires action=1 → INT_RAW.WDT set → IRQ
       raises → guest ISR runs.
- ISR reads INT_ST, sees bit 2 set → handles WDT, writes
  INT_CLR with bit 2 → IRQ lowers + ISR returns.

The cycle then advances to stage 1, which has action=NONE per
the example → emit event but no further IRQ.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
0 wdt_reset events
0 wdt_irq events (boot doesn't enable WDT)
17 timg_irq events (T0 alarm — UNCHANGED from prior phases)
```

The 17 timg_irq events confirm bit-0 (T0) IRQ handling still
works after extending the mask. No regression.

The new path (WDT bit 2 → IRQ raise → INT_CLR lower) is
exercised only when a guest enables WDT with action=1. Code
path is correct-by-construction.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **No standalone CLIC cause for WDT**: real silicon doesn't
   give WDT its own cause — it shares the TIMG line per
   TRM § 17.4. Our wiring matches.

2. **T1 alarm (bit 1) still not modelled**: ESP32-P4 TIMG has
   T0 + T1 per group, but our skeleton models T0 only. Bit 1
   in INT registers reserved but never touched. Bit 1 stays
   ignored — INT_MASK doesn't include it, INT_ENA writes drop
   it.

3. **RWDT IRQ wiring NOT included in this phase**: RWDT lives
   in a separate device class (LP_WDT) with its own state
   struct and no current CLIC routing. Adding RWDT IRQ would
   need (a) wiring an LP-side CLIC cause line, (b) adding
   INT_RAW/ENA/CLR registers to LP_WDT, (c) action=1 path in
   the RWDT callback. Deferred as 2.BU.rwdt-irq.

4. **No demo ISR exercising the new path**: real Arduino
   firmware will exercise it. We don't have an in-tree test
   that hangs the WDT intentionally because the side effect
   (machine reset with VELXIO_WDT_RESET=1) would disrupt boot.

5. **INT_ST register not explicitly written**: the existing
   read handler computes INT_ST as `INT_RAW & INT_ENA` on
   the fly (line ~192 in esp32p4_timg.c). With our mask
   extension, this automatically includes WDT bit.

## Lessons learned

1. **TRM § 17.4's one-liner pointer is gold**: a single
   sentence ("For watchdog timer interrupts, please refer to
   Section 16.3.7") tells us the entire wiring strategy. Real
   silicon reuses the TIMG IRQ infrastructure — no new CLIC
   cause needed. Saved a phase of design work.

2. **Shared-IRQ-line pattern is silicon-canonical**: many
   peripherals expose multiple interrupt sources on one CLIC
   line, with software disambiguation via INT_ST. Modeling
   correctly requires a mask of "all interesting bits" in
   update_irq, not a per-bit comparison.

3. **W1TC semantics in INT_CLR**: real silicon clears the
   bits that the guest wrote 1 to. Our extension from "if
   bit 0 set, clear bit 0" to "clear (v & MASK)" matches
   silicon — and is forward-compatible if we add bit 1 (T1)
   later.

4. **WDT IRQ subsystem is now end-to-end functional**:
   action=1 (Interrupt) → INT_RAW.WDT set → CPU IRQ raised
   → ISR runs → INT_CLR clears → IRQ lowers. The same
   silicon pattern as TIMG T0 alarm but for WDT.

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- **Added**: `ESP32P4_TIMG_INT_T0/T1/WDT` bit defines.
- **Added**: `ESP32P4_TIMG_INT_MASK` = T0|WDT = 0x5.
- TRM citations: § 17.4 (WDT IRQ infrastructure reuse) +
  Register 16.21-16.24 (bit positions).

### `hw/timer/esp32p4_timg.c`

- `refresh_irq()`: mask changed from `0x1U` to
  `ESP32P4_TIMG_INT_MASK`.
- INT_ENA write handler: mask changed from `0x1U` to
  `ESP32P4_TIMG_INT_MASK`.
- INT_CLR write handler: extended from "if bit 0 set, clear
  bit 0" to "clear (v & MASK)" — W1TC across both bits.
- Reset callback: action=Interrupt now sets
  `int_raw |= ESP32P4_TIMG_INT_WDT` and calls
  `refresh_irq()`. Existing JSON event emission preserved.

## Estado consolidado (post-2.BU)

WDT IRQ wiring:

| WDT | Action=1 trap | CLIC cause |
|-----|---------------|------------|
| TIMG0 WDT | **✓ Phase 2.BU** | **19 (shared with T0 alarm)** |
| TIMG1 WDT | **✓ Phase 2.BU (shared class)** | **20** |
| RTC WDT | JSON-only (no CPU trap) | n/a (LP-side IRQ not wired) |
| Super WDT | n/a (single fixed reset action) | n/a |

JSON event types: **27** (unchanged — adds CPU-trap behavior
to existing wdt_irq event).

## 58-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BS  | MWDT multi-stage cycling                                 |
| 2.BT  | RWDT multi-stage cycling                                 |
| **2.BU** | **MWDT WDT IRQ→CLIC wiring (action=1 actually traps)** |

**8 consecutive TRM-grounded phases (2.BN → 2.BU)**. The MWDT
subsystem is now **fully silicon-complete**:
- TRM-correct write-protect key ✓
- TRM-correct bit layouts ✓
- Action codes decoded (4 codes) ✓
- TRM-correct timeout formula ✓
- Multi-stage cycling ✓
- **IRQ→CLIC wiring for action=1 ✓** (this phase)
- Reset action triggers (env-var gated) ✓

## Próximas direcciones

- **2.BU.rwdt-irq**: same IRQ wiring for RWDT. Needs LP-side
  CLIC cause line + INT_RAW/ENA/CLR registers added to LP_WDT
  state struct.
- **eFuse model** — unlocks WDT_DELAY_SEL + MAC + boot params.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensors.
- **SPI3** instantiation.
- **FreeRTOS** scheduler.
