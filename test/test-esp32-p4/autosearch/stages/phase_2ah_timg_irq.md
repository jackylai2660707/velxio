# Phase 2.AH — TIMG → CPU IRQ wiring

**Estado**: ✅ done — TIMG0's alarm now propagates through the
`espressif-cpu-irq-lines` matrix at cause 19. End-to-end live test
shows the IRQ line transitioning from 0→1 the instant after the first
alarm match. Ready for Phase 2.AI to install a guest-side ISR that
clears INT_CLR and creates a steady-state alarm-driven workload.

## Goal

Close the second half of the Arduino-style hardware-timer chain:

```
guest writes ALARM → counter == alarm → INT_RAW set
                                      → (raw & ena) → IRQ line high
                                      → CLIC dispatches → CPU traps
                                      → guest ISR runs (Phase 2.AI)
                                      → ISR writes INT_CLR → IRQ low
```

Phase 2.AG built the left half (alarm match → INT_RAW). Phase 2.AH
wires the right half up to "CPU IRQ line high" and proves it with a
live transition.

## Lo que SE INVESTIGÓ

### 1. Picking a free CLIC cause line

ESP32-P4 CLIC has 32 cause lines (per Phase 2.D scaffold). Current
allocation:

| Cause | Source                         | Phase  |
|-------|--------------------------------|--------|
| 17    | SYSTIMER tick                  | 2.K    |
| 18    | GPIO consolidated              | 2.AB   |
| 19    | **TIMG0 (this phase)**         | 2.AH   |
| 20+   | free for TIMG1 / I2C / SPI ... | future |

In Phase 2.AA we briefly used 18-25 for individual pin IRQs; Phase
2.AB consolidated those to a single shared line at 18. So 19+ is
clean.

### 2. Mirroring the GPIO wiring pattern

Phase 2.AB taught the right pattern for "consolidated peripheral IRQ
to CPU":

  - Device declares `qemu_irq irq_out` field
  - `qdev_init_gpio_out_named(dev, &s->irq_out, "esp32p4.timg.intr", 1)`
    in realize
  - Refresh helper sets the line based on `(int_raw & int_ena) != 0`
  - Helper called on alarm fire / INT_ENA write / INT_CLR write
  - Machine init connects the named output to `espressif-cpu-irq-lines`
    at the chosen cause

TIMG follows this template verbatim. The benefit of mirroring the
GPIO pattern: real ISRs that already handle the GPIO consolidated-IRQ
shape (read INT_ST, branch on cause, W1TC clear) work for TIMG with
just the cause/register-base change.

### 3. Race conditions on transition logging

First implementation used `static uint8_t prev_level` inside the
refresh function. That works for a single TIMG instance but breaks
the moment TIMG1 is added (both share the static — wrong reports).
Fix: moved `irq_prev_level` into `ESP32P4TimgState` so each instance
tracks its own.

`reset()` was also updated to **preserve** `int_ena` and
`irq_prev_level` across the post-init device reset (the same pattern
that keeps `alarm`/`load`/`config` alive in Phase 2.AG).

### 4. Choosing what NOT to enable in the self-test

Setting `int_ena = 1` makes the IRQ propagate. The CPU with no
TIMG-aware ISR will fault on the trap *if* mstatus.MIE is set. Two
possible outcomes when our self-test enables int_ena:

  (a) Bypass flow has MIE=0 — IRQ queues silently in CLIC, no trap,
      no regression. Steady-state: line stays high after first alarm.
  (b) Bypass flow has MIE=1 — IRQ traps to mtvec=0 (or some default
      handler), CPU panics, demo blob stops.

We bet on (a) and the live test confirmed it: the running-light + LEDC
+ ADC events continue identical to Phase 2.AG, and the timg_irq
level=1 transition is logged once. Outcome: full IRQ wiring proven
without breaking the existing demo.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 343  (was 342 in Phase 2.AG — +1 timg_irq)
  "event":"ledc":     99  (Phase 2.AF unchanged)
  "event":"adc":      33  (Phase 2.AD unchanged)
  "event":"timg":      9  (Phase 2.AG unchanged)
  "event":"timg_irq":  1  ← NEW
  "event":"start":     1
  "pin":             200
```

Sample IRQ event:

```json
{"t_ns":1003219459,"event":"timg_irq","grp":0,"line":19,"level":1}
```

Timing confirms the wiring: t_ns=1003219459 (≈1 second after boot)
matches the first TIMG alarm fire at t_ns=1003091750 (Phase 2.AG
test). The 128 µs gap is because:

  - Alarm fire happens in the QEMUTimer alarm-watch callback
  - INT_RAW is set, then `esp32p4_timg_refresh_irq()` is called
  - Inside refresh: level computed = (int_raw & int_ena) = 1
  - prev_level = 0 → level = 1, transition emits the JSON event

Only one transition appears in 10 seconds because no ISR clears
INT_CLR. The IRQ line stays high at the CLIC after first fire. With
auto-reload counter restarting and INT_RAW already set, subsequent
alarm fires don't generate new transitions (level remains 1).

The stderr log confirms in-VM behaviour:

```
[esp32p4.timg] T0 alarm fired @ counter=1003091  (Phase 2.AG line)
[esp32p4.timg] CPU IRQ line -> 1 (cause 19)       ← NEW Phase 2.AH
... (subsequent alarms fire but don't toggle the line)
```

## Lo que NO funcionó / decisiones tomadas

1. **Considered: making the IRQ pulse rather than level-stay-high**:
   would need to mimic real silicon's edge-vs-level behaviour. Real
   ESP32-P4 TIMG fires a level-sensitive IRQ that stays asserted
   until ISR clears INT_CLR. We mirror that — easier and matches
   silicon. Phase 2.AI's ISR will clear INT_CLR and the line will
   pulse naturally.

2. **Considered: also wiring TIMG1**: not yet. TIMG1 (0x500C0000)
   isn't instantiated. Adding it is a 5-line copy-paste once needed.
   Would map to cause 20.

3. **Considered: testing CPU trap delivery**: would need to install
   a small mtvec stub that handles cause 19. Real test would be:
   ISR sets a memory flag, demo blob polls for the flag, on flag
   set toggle a GPIO pin. Total: ~6 instructions of ISR + ~3 of
   blob mod. Deferred to Phase 2.AI as it's substantial enough to
   stand alone.

4. **`int_ena` set in machine self-test (deviation from real
   silicon)**: real boot would have int_ena=0 until the guest
   driver writes to it. We set it in self-test to validate the
   wiring without needing guest code. Phase 2.AI replaces this
   with proper guest-driven INT_ENA write.

## Lessons learned

1. **Per-instance prev-level avoids static-var landmines**: the
   first implementation with `static uint8_t prev_level` worked
   for a single TIMG but would silently break with TIMG1. Moving
   to device state is the correct pattern from the start.

2. **Level-sensitive IRQ + transition logging is enough for
   observability**: a single 0→1 event in the JSON log proves
   end-to-end wiring without needing a steady stream of events.
   Phase 2.AI's ISR will create the steady-state firing pattern.

3. **Self-test deviations from real silicon are OK if documented**:
   we now keep `int_ena` and `irq_prev_level` across reset; real
   silicon resets both. Documented as "Phase 2.AI cleanup item"
   so future Claude knows it's intentional.

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- New field `qemu_irq irq_out` for the consolidated CPU IRQ output.
- New field `uint8_t irq_prev_level` for transition tracking.

### `hw/timer/esp32p4_timg.c`

- `#include "hw/irq.h"` for `qemu_set_irq`.
- New `esp32p4_timg_refresh_irq()` helper. Sets the line and emits
  a `timg_irq` JSON event + stderr line on transition.
- Calls to refresh in:
  - `check_alarm()` after setting INT_RAW
  - `INT_ENA` write handler
  - `INT_CLR` write handler
- `realize()`: register the named output GPIO line.
- `reset()`: preserve `int_ena` and `irq_prev_level` (Phase 2.AH
  self-test maintenance).

### `hw/riscv/esp32p4.c`

- Self-test now also sets `ms->timg0.int_ena = 0x1U`.
- New `qdev_connect_gpio_out_named()` call wiring `esp32p4.timg.intr`
  to `espressif-cpu-irq-lines` cause 19.

## Estado consolidado (post-2.AH)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| UART hello world                                              | ✅     |
| GPIO output + ENABLE multiplexer + JSON channel               | ✅ 2.W |
| GPIO IRQ (latched status, edge filter, shared CPU IRQ)        | ✅ 2.AB|
| LEDC PWM + multi-channel demos                                | ✅ 2.AC-AF |
| ADC analog samples                                             | ✅ 2.AD|
| TIMG0 hardware timer + alarm + JSON event                     | ✅ 2.AG|
| **TIMG → CPU IRQ wiring (cause 19, end-to-end verified)**     | ✅ 2.AH|
| Guest ISR demo for TIMG (Arduino attachInterrupt-style)       | ⏳ 2.AI|
| TIMG1 + watchdog                                               | ⏳ later|
| I2C / SPI master                                               | ⏳ later|
| Real PWM waveform on GPIO                                     | ⏳ later|
| Real FreeRTOS port                                             | ⏳ Phase 2.V |

## 15-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U   | Hand-rolled GPIO toggle (busy-wait)                     |
| 2.V   | 3-pin running light cycling                             |
| 2.W   | GPIO input + ENABLE multiplexer                         |
| 2.X   | JSON event stream → frontend                            |
| 2.X.in| JSON input fifo ← frontend                              |
| 2.Y   | SYSTIMER virtual-time deterministic timing              |
| 2.Z   | GPIO pin-transition IRQ to CPU                          |
| 2.AA  | INT_TYPE filter + 8-pin wiring                          |
| 2.AB  | Real-silicon shared IRQ + latched INT_STATUS            |
| 2.AC  | LEDC PWM duty-cycle events                              |
| 2.AD  | ADC peripheral + ADC→LEDC pipeline                      |
| 2.AE  | LEDC 2-channel crossfade                                |
| 2.AF  | LEDC 3-channel rainbow                                  |
| 2.AG  | TIMG hardware timer + alarm comparator                  |
| **2.AH** | **TIMG → CPU IRQ wiring (cause 19)**                  |

JSON stream now carries 6 event types: `start | pin | ledc | adc | timg | timg_irq`.

## Próximas direcciones

- **Phase 2.AI** (highest priority): tiny guest ISR demo. Install
  mtvec stub, ISR clears INT_CLR + toggles a GPIO pin. Visible
  result: pin toggles at exactly 1 Hz driven by real timer hardware
  IRQ. This completes the Arduino `attachInterrupt(timer, isr,
  EDGE)` chain end-to-end.
- **Phase 2.AH.timg1**: copy TIMG0 → TIMG1 at 0x500C0000 + cause 20.
- **Phase 2.AG.div**: respect the DIVIDER field (currently 1 MHz).
- I2C master, SPI master — sensor demos.
- Real FreeRTOS port (Phase 2.V deferred).
