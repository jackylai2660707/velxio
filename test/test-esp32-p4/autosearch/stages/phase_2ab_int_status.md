# Phase 2.AB — INT_STATUS register + consolidated GPIO IRQ

**Estado**: ✅ done — refactored Phase 2.Z/AA's per-pin direct CPU
wiring into the real-silicon-style **shared GPIO IRQ + latched
INT_STATUS register** model. All 32 pins now feed a single CPU cause
(18) via `intr_out`; ISRs read GPIO_INT_STATUS to identify source
pins and clear via INT_STATUS_W1TC.

## Goal

The Phase 2.Z/AA design wired each GPIO pin to its own CPU cause
(8 pins → causes 18..25). That's a per-pin model, useful for proof-
of-concept but **not** how real silicon works. ESP32-P4 has a
single GPIO interrupt line per HP core (GPIO_INTn_INT_REG) with a
latched per-pin pending status (32 bits). ISRs identify the source
by reading the status register, then write-1-to-clear handled bits.

Phase 2.AB brings the model to that real-silicon shape.

## Lo que SE INVESTIGÓ

### 1. Real-silicon GPIO IRQ shape

Per TRM Cap 9, GPIO has:

  - GPIO_STATUS_REG / GPIO_STATUS_W1TS / GPIO_STATUS_W1TC: 32-bit
    pending status, bit N = pin N has a pending IRQ.
  - GPIO_PINx_REG.INT_TYPE: 3-bit per-pin trigger config
    (none/RISING/FALLING/ANY/LEVEL_LOW/LEVEL_HIGH).
  - GPIO_PINx_REG.INT_ENA: per-core IRQ-enable (route to which core).
  - GPIO_INTn_INT_REG: aggregate IRQ to CPU n (HP0/HP1).

The aggregate IRQ asserts while `(GPIO_STATUS & GPIO_INT_ENA) != 0`.
ISR reads STATUS, identifies source, handles, writes W1TC.

For our model we model:
  - INT_ENA mask (Phase 2.Z) — 32-bit per-pin enable.
  - INT_RISING + INT_FALLING masks (Phase 2.AA) — collapsed
    INT_TYPE field.
  - **INT_STATUS register** (Phase 2.AB) — latched 32-bit pending.
  - Single consolidated IRQ output `intr_out` (Phase 2.AB).

### 2. Shared IRQ output via `qdev_init_gpio_out_named`

Replaced the 8-element `pin_irq[]` direct wiring with a single
`intr_out` qemu_irq:

```c
qdev_init_gpio_out_named(dev, &s->intr_out, "esp32p4.gpio.intr", 1);
```

Then in machine init, one line wires it to CPU cause 18:

```c
qdev_connect_gpio_out_named(
    DEVICE(&ms->gpio), "esp32p4.gpio.intr", 0,
    qdev_get_gpio_in_named(DEVICE(&ms->soc),
                           "espressif-cpu-irq-lines", 18));
```

The 8-pin Phase 2.AA loop is gone. The per-pin `pin_irq[N]`
outputs from the GPIO model are still emitted on every transition
(useful for external observers — LED listeners, JSON event
subscribers, future virtual-LED widgets) but no longer feed the
CPU's interrupt input directly.

### 3. INT_STATUS latch + W1TC clear

When a pin transition matches its trigger type (rising/falling/
any-edge), `int_status |= (1 << pin)` is latched. The
consolidated `intr_out` is then computed as
`(int_status != 0) ? 1 : 0` and forwarded to the CPU.

The ISR clears handled bits by writing 1 to the corresponding bit
in INT_STATUS_W1TC (offset 0xA4):

```c
case R_GPIO_INT_STATUS_W1TC:
    s->int_status &= ~v;
    esp32p4_gpio_refresh_intr_out(s);
    break;
```

If clearing returns int_status to zero, intr_out drops back to 0,
deasserting the CPU IRQ.

### 4. Critical: only refresh intr_out when int_status changes

First implementation called `refresh_intr_out` on every update.
Result: every running-light pin 5/6/7 toggle triggered a
`set_irq(intr_out, 0)` (since int_status remains 0 for those
pins). The CPU's IRQ handler then logged hundreds of
`line=18 level=0` events per second — flooding stderr.

Fix: snapshot `prev_status` before the transition loop, only call
refresh if `int_status != prev_status` after the loop:

```c
uint32_t prev_status = s->int_status;
... process transitions ...
if (s->int_status != prev_status) {
    esp32p4_gpio_refresh_intr_out(s);
}
```

Now intr_out only asserts when bits are first latched, and only
deasserts when bits are explicitly cleared. Matches real silicon.

## Lo que SÍ funcionó

10-second test with `ESP_CPU_IRQ_DEBUG=1`:

```
[esp32p4.gpio] pin 0 -> 1                  ← FIRST press, rising edge
[esp_cpu.irq_handler] line=18 level=1      ← intr_out goes high
                                            (int_status[0] latched)
[esp32p4.gpio] pin 0 -> 0                  ← release: int_status unchanged,
                                            no new IRQ
[esp32p4.gpio] pin 0 -> 1                  ← 2nd press: int_status[0]
                                            already 1, no change in
                                            intr_out, no IRQ event
```

Behavior matches real silicon:
- Edge IRQ latches into status.
- Status stays asserted until ISR clears.
- Multiple presses (without ISR clear) don't generate additional
  IRQ events.

Default build (no DEBUG): unchanged, 103 patches active. The
running light + fake button output looks the same as Phase 2.AA.

## Lo que NO funcionó (durante implementación)

1. **First version: refresh intr_out unconditionally on every
   update**. Caused massive stderr flood — every pin 5/6/7
   running-light toggle queued a `set_irq(intr_out, 0)` call,
   logged by the CPU's debug. Fixed by tracking
   `prev_status` and only refreshing on actual status change.

2. **Considered: keep the 8-pin direct wiring AND add INT_STATUS**
   for hybrid use. Rejected — that's NOT how real silicon works,
   and having two redundant IRQ paths confuses the model. The
   `pin_irq[N]` outputs are still emitted (for non-CPU
   subscribers like LED listeners) but don't feed the CPU.

## Lessons learned

1. **Refreshing irq lines is expensive when CPU is in debug mode**:
   even though the underlying `qemu_set_irq(line, X)` is
   idempotent if X matches the previous value, the CPU IRQ
   handler still gets called and logs the event in debug builds.
   Track prev-state and only call set_irq when state changes.

2. **Latched + clear-on-W1TC is the right pattern for edge IRQs**:
   without latch, edge transitions disappear after the assert →
   ISR can miss them. With latch, the IRQ stays high until the
   ISR explicitly handles the source. Universal embedded-systems
   pattern.

3. **`qdev_init_gpio_out_named(dev, &single, "name", 1)` is
   different from `qdev_init_gpio_out_named(dev, array, "name", N)`**:
   the first creates one named output line; the second creates
   N indexed outputs of the same name. Both are accessible via
   `qdev_connect_gpio_out_named(... , idx, ...)`.

## Implementación final

### `include/hw/gpio/esp32p4_gpio.h`

Added:
- `int_status` field — latched per-pin pending IRQ.
- `intr_out` qemu_irq — single consolidated CPU IRQ output.
- Updated docstring with INT_STATUS register layout and
  consolidated-IRQ semantics.

### `hw/gpio/esp32p4_gpio.c`

- `esp32p4_gpio_refresh_intr_out` helper — sets intr_out level
  based on `(int_status != 0)`.
- Updated `update()` to latch matching edges into `int_status`
  AND track `prev_status` to decide when to refresh intr_out.
- Added register decode for INT_STATUS (read) + W1TC (clear +
  refresh).
- `qdev_init_gpio_out_named` for `intr_out` in realize.
- Reset clears `int_status`.

### `hw/riscv/esp32p4.c`

- Replaced 8-pin `for` loop with single
  `qdev_connect_gpio_out_named` wiring `intr_out` to CPU cause
  18. The per-pin `gpio.pin[N]` outputs no longer connect to the
  CPU.

## Estado consolidado (post-2.AB)

| Hito                                                     | Estado |
|----------------------------------------------------------|--------|
| GPIO output (running light, deterministic timing)        | ✅ 2.Y |
| GPIO input + ENABLE multiplexer + JSON I/O channel       | ✅ 2.W/X |
| GPIO transition → CPU IRQ (any-edge filter, single pin)  | ✅ 2.Z |
| RISING/FALLING/ANY-edge filter, 8-pin wiring             | ✅ 2.AA|
| **Real-silicon-style: latched INT_STATUS + shared IRQ**  | ✅ 2.AB|
| LEVEL_HIGH/LEVEL_LOW triggers                            | ⏳ later |
| Other peripherals (LEDC PWM, I2C, SPI, ADC)              | ⏳ later |

## Realism progression so far (9 phases since 2.U)

| Phase | Capability                                        |
|-------|---------------------------------------------------|
| 2.U   | Hand-rolled GPIO toggle (busy-wait)               |
| 2.V   | 3-pin running light cycling                       |
| 2.W   | GPIO input pads + ENABLE multiplexer              |
| 2.X   | JSON output stream → frontend                     |
| 2.X.input | JSON input fifo ← frontend                    |
| 2.Y   | SYSTIMER virtual-time deterministic timing        |
| 2.Z   | GPIO pin-transition IRQ to CPU (single pin)       |
| 2.AA  | INT_TYPE filter (RISING/FALLING/ANY) + 8-pin wiring |
| **2.AB** | **Latched INT_STATUS + consolidated shared IRQ** |

The GPIO interrupt model is now architecturally correct relative
to real silicon: edge filtering, status latching, ISR clear-via-
W1TC, single CPU cause line. End-to-end `attachInterrupt(pin,
ISR, MODE)` would just need:
1. The IDF runtime to set mtvt[18] to a real handler (Phase 2.S
   already validated CLIC vectoring for this cause).
2. The user sketch to call `interrupts()` (set mstatus.MIE).
3. The handler to call `gpio_intr_clear` (write to INT_STATUS_W1TC).

All three are sketch-side concerns, unblocked by Phase 2.V's
(deferred) FreeRTOS port.

## Próximas fases

- **LEVEL_HIGH / LEVEL_LOW triggers**: completes the INT_TYPE
  set. Less commonly used in Arduino sketches but standard for
  shared-line peripherals.

- **Peripherals**: LEDC PWM (visible "fade" demo), I2C/SPI
  master (sensor readout), ADC (analog input).

- **Phase 2.V (deferred)**: real FreeRTOS port — multi-week.
  Unblocks `setup()/loop()` natural Arduino flow.
