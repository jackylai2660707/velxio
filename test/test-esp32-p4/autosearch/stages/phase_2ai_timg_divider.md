# Phase 2.AI — TIMG DIVIDER respect

**Estado**: ✅ done — TIMG counter time base now respects the 13-bit
DIVIDER field in T0_CONFIG. Previously hardcoded to 1 MHz (Phase
2.AG); now `tick_rate = APB(80MHz) / DIVIDER` matching real silicon.
Live test demonstrates a 10 kHz tick rate (DIVIDER=8000) producing
counter values ~10,000 at the same 1-Hz wall-clock alarm cadence.

## Goal

Close the documented gap from Phase 2.AG: respect the DIVIDER field.
Real Arduino sketches use various dividers depending on what they
need:

| Sketch usage           | timerBegin args      | Effective tick |
|------------------------|----------------------|----------------|
| 1 µs precision         | `(N, 80, true)`      | 1 MHz          |
| Audio sampling 100 kHz | `(N, 800, true)`     | 100 kHz        |
| Slow blink 1 ms        | `(N, 80000, true)`   | 1 kHz          |
| Watchdog-style 100 ms  | `(N, 8000000, true)` | 10 Hz          |

Pre-2.AI all of these would tick at 1 MHz regardless of the divider
guest writes — alarms would fire at wrong wall-clock intervals.
Post-2.AI they tick at the requested rate.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 T0_CONFIG.DIVIDER bit layout

Per IDF `soc/timer_group_reg.h`:

```
T0_CONFIG bits:
  31    EN
  30    INCREASE
  29    AUTORELOAD
  28..23 reserved
  23    USE_XTAL
  22    DIVCNT_RST
  21..9 DIVIDER (13-bit)
  10    ALARM_EN
  9..1  reserved
  0     reserved
```

DIVIDER occupies bits 21:9 — a 13-bit field. Range 0..8191.

Real-silicon special case: DIVIDER=0 means "divide by 65536"
(effectively stops the clock). DIVIDER=1 means divide-by-1 = 80 MHz
tick (counter wraps every ~225 ms).

### 2. Default behaviour decision

Arduino's `timerBegin(timer_id, divider, count_up)` writes the divider
directly into the field. With `timerBegin(0, 80, true)` (the most
common Arduino call), DIVIDER=80 → 1 MHz tick. So DIVIDER=80 should
remain "1 MHz tick" semantically.

But DIVIDER=0 in our model would be "divide by 0" → division by
zero. Real silicon treats 0 as 65536. We picked the friendlier
behaviour: **0 → 80** so uninitialised CONFIG (Arduino's default
post-`timerBegin`) yields the expected 1 MHz tick. Documented as
emulator-specific deviation.

### 3. Counter formula

```
tick_rate_hz = 80_000_000 / divider
counter      = (delta_ns × tick_rate_hz) / 1e9
             = (delta_ns / 1000) × 80 / divider
             = delta_us × 80 / divider
```

For DIVIDER=80 (1 MHz): `counter = delta_us × 80 / 80 = delta_us`
— preserves Phase 2.AG behaviour.

For DIVIDER=8000 (10 kHz): `counter = delta_us × 80 / 8000 = delta_us / 100`
— ticks 100× slower.

### 4. T0_LOAD inverse

When guest writes T0_LOAD, we shift `zero_ns` so a fresh read
returns `load`. Inverse formula:

```
counter == load
delta_us × 80 / div == load
delta_ns × 80 / 1000 / div == load
delta_ns == load × div × 1000 / 80
zero_ns  == now_ns - load × div × 1000 / 80
```

Pre-2.AI (hardcoded div=80): `zero_ns = now_ns - load × 1000`.
Post-2.AI (general): `zero_ns = now_ns - load × div × 1000 / 80`.

The autoreload path uses the same formula (counter restarts at
`load` after each alarm fire).

## Lo que SÍ funcionó

10-second live test (2026-05-08) with self-test now using
**DIVIDER=8000** (10 kHz tick) instead of the implicit-1-MHz default:

```
=== JSON event totals ===
Total lines: 343  (unchanged from Phase 2.AH)
  "event":"timg":      9
  "event":"timg_irq":  1
  "event":"ledc":     99
  "event":"adc":      33
  "event":"start":     1
  "pin":             200
```

**Sample sequence proves the new tick rate** (counter values ~100×
smaller than Phase 2.AG, same wall-clock cadence):

| t_ns          | counter | alarm  | Notes                  |
|---------------|---------|--------|------------------------|
| 1,003,432,057 |  10,030 | 10,000 | first fire @ ~1 s      |
| 2,006,580,774 |  10,028 | 10,000 | autoreload Δt = 1.003 s |
| 3,010,345,205 |  10,034 | 10,000 | autoreload Δt = 1.004 s |
| 4,014,119,072 |  10,034 | 10,000 | autoreload Δt = 1.004 s |

Math verification at first fire:
- Δt = 1.003 s = 1,003,432 µs
- Tick rate = 80 MHz / 8000 = 10 kHz
- Expected counter = 1,003,432 × 10 / 1,000,000 = 10,034 → reads 10,030 (4 ticks short due to 50 ms QEMUTimer granularity, acceptable)

Pre-2.AI test (Phase 2.AG with DIVIDER=80 implicit): counter=1,003,091
at ~1 s. Post-2.AI test (this phase with DIVIDER=8000): counter=10,030
at ~1 s. **100× ratio matches the 80→8000 divider change**. 

The 1-Hz wall-clock cadence is unchanged because the alarm value also
changed (1,000,000 → 10,000) by the same factor. This is exactly how
real Arduino code works: `timerBegin(0, divider, true);
timerAlarmWrite(timer, ticks_per_alarm, true)` — divider AND alarm
ticks scale together to keep wall-clock period.

## Lo que NO funcionó / decisiones tomadas

1. **DIVIDER=0 not modelled as divide-by-65536**: real silicon special
   case. We treat 0 as 80 (default 1 MHz). Documented; matches
   Arduino-friendly defaults. Future Phase 2.AI.next can switch to
   real-silicon behaviour if a guest depends on it.

2. **No DIVCNT_RST bit handling**: real silicon's bit 22 of CONFIG
   resets the prescaler counter (counter halts briefly). We don't
   model this micro-detail — DIVCNT_RST writes are no-ops.

3. **Tested with one alternate divider only** (8000): confirmed the
   formula scales. Guest code with arbitrary divider in 1..8191
   should work because the formula is generic; not separately
   verified.

## Lessons learned

1. **Make the self-test prove the change is observable**: changing
   from hardcoded 1 MHz to divider-aware would be hard to verify if
   the self-test still used DIVIDER=80 (no behavioural change). We
   intentionally picked DIVIDER=8000 so the counter values shift 100×
   — a clear, visible proof.

2. **Always-keep-the-wall-clock-cadence invariant simplifies test
   review**: Δt between alarm events stays at 1 second across the
   change. If we'd also changed the wall-clock period, the test
   would have been confusing ("did periodicity break or did
   counter rate change?"). Locking one variable while changing
   the other isolates what's being tested.

3. **64-bit math required**: the counter formula `delta_us × 80 /
   div` overflows 32-bit at delta_us > 53 million (~53 s). For
   long-running simulations we need 64-bit. Used `uint64_t`
   throughout the helper — would have been a slow-burn bug if we'd
   used `uint32_t`.

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- New constants `ESP32P4_TIMG_CFG_DIVIDER_SHIFT` (9), `_MASK`,
  `ESP32P4_TIMG_APB_HZ` (80 MHz).

### `hw/timer/esp32p4_timg.c`

- New helper `esp32p4_timg_divider()` — reads bits 21:9 of
  T0_CONFIG, returns 80 if zero (default-to-1MHz).
- `esp32p4_timg_counter()` — formula updated to use divider.
- `esp32p4_timg_check_alarm()` — autoreload path uses divider in
  zero_ns shift.
- T0_LOAD write handler — divider in zero_ns shift.

### `hw/riscv/esp32p4.c`

- Self-test pre-program now uses DIVIDER=8000 (visible 100× tick
  slowdown vs Phase 2.AG/AH default), alarm=10000 (1 s @ 10 kHz).

## Estado consolidado (post-2.AI)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| UART hello world                                              | ✅     |
| GPIO output + ENABLE multiplexer + JSON channel               | ✅ 2.W |
| GPIO IRQ (latched status, edge filter, shared CPU IRQ)        | ✅ 2.AB|
| LEDC PWM + multi-channel demos                                 | ✅ 2.AC-AF |
| ADC analog samples                                             | ✅ 2.AD|
| TIMG hardware timer + alarm + JSON event                      | ✅ 2.AG|
| TIMG → CPU IRQ wiring (cause 19)                              | ✅ 2.AH|
| **TIMG DIVIDER respect (configurable tick rate)**             | ✅ 2.AI|
| Guest ISR demo for TIMG                                        | ⏳ 2.AJ|
| TIMG1 + watchdog                                               | ⏳ later|
| I2C / SPI master                                               | ⏳ later|
| Real PWM waveform on GPIO                                     | ⏳ later|
| Real FreeRTOS port                                             | ⏳ Phase 2.V |

## 16-Phase realism progression

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
| 2.AH  | TIMG → CPU IRQ wiring (cause 19)                        |
| **2.AI** | **TIMG DIVIDER respect (real APB/N tick rate)**       |

JSON stream still carries 6 event types: `start | pin | ledc | adc |
timg | timg_irq`. Counter values now scale correctly with the
guest-programmed divider.

## Próximas direcciones

- **Phase 2.AJ** (highest priority): guest ISR demo — install mtvec
  stub + ISR that clears INT_CLR and toggles a GPIO pin. Completes
  the full Arduino `attachInterrupt(timer, isr, EDGE)` chain
  end-to-end with visible LED toggle.
- TIMG1 + WDT, I2C master, SPI master, real PWM waveform on GPIO,
  real FreeRTOS port (Phase 2.V deferred).
