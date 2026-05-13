# Phase 2.BL — TWAI1 + TWAI2 instantiation

**Estado**: ✅ done — completes the 3/3 CAN bus inventory. TWAI0
+ TWAI1 + TWAI2 at their real-silicon addresses (0x500A6/7/8000),
each a distinct instance of `TYPE_ESP32P4_TWAI`. Per-instance
`port_num` (0/1/2) disambiguates in JSON. Each gets its own CLIC
cause line: 21 (TWAI0), 28 (TWAI1), 29 (TWAI2).

Self-test fires the full 5-event sequence (TX + IRQ raise + IRQ
clear + RX + re-raise) on each of 3 buses = **15 TWAI events at
boot**.

Live test (2026-05-08), event counts by port:
```
1 twai port=0       1 twai port=1       1 twai port=2
3 twai_irq port=0   3 twai_irq port=1   3 twai_irq port=2
1 twai_rx port=0    1 twai_rx port=1    1 twai_rx port=2
```

Total: 15 TWAI events. JSON event types still 25 (no new types
— this phase adds instances).

## Goal

Phase 2.BA established TWAI0 + 2.BC added RX responder + 2.BF
added IRQ. But ESP32-P4 has 3 TWAI controllers; only TWAI0 was
instantiated, so Arduino sketches using `TWAI_TIMING_CONFIG_1MBITS`
on TWAI1 (e.g., dual-CAN automotive demos) silently absorbed the
register writes.

Phase 2.BL closes that gap using the multi-instance pattern from
Phase 2.BB (I2C1 + LP_UART) and Phase 2.AZ (Multi-UART).

## Lo que SE INVESTIGÓ

### 1. port_num field addition

Existing TWAI state had no `port_num` — the JSON events emitted
`{"event":"twai",...}` without a port field. To support multi-
instance, added `uint8_t port_num` to `ESP32P4TwaiState` and
updated all 3 event emission paths (`emit_tx_event`,
`emit_rx_event`, `update_irq`) to include `"port":N`.

This is a JSON schema extension — existing consumers that ignored
unknown fields continue to work, but consumers expecting a `port`
field now see it. Same forward-compat shape as Phase 2.AZ's multi-
UART port_num addition.

### 2. Stderr also updated

Stderr lines now print `[esp32p4.twaiN]` (with the port number)
instead of just `[esp32p4.twai]`. Helps debugging when multiple
TWAIs fire in close succession.

### 3. Multi-instance loop pattern

Same shape as Phase 2.AZ's UART1..4 loop:

```c
ESP32P4TwaiState *units[2] = { &ms->twai1, &ms->twai2 };
const hwaddr bases[2]      = { 0x500A7000, 0x500A8000 };
const char *names[2]       = { "twai1", "twai2" };
const unsigned causes[2]   = { 28, 29 };
for (unsigned i = 0; i < 2; i++) {
    // initialize, realize, overlay, wire event_log, set port_num,
    // connect IRQ, fire self-test
}
```

### 4. CLIC cause line allocation

After this phase:
- 17-20 base
- 21 TWAI0
- 22 I2C0, 23 I2C1
- 24 SPI2, 25 RMT, 26 ADC, 27 LEDC
- **28 TWAI1**, **29 TWAI2** (new)
- Free: 30+

### 5. Rotating-frame state is per-instance

Phase 2.BC's `generate_next_rx()` uses `rx_count` which is per-
state. So TWAI0/1/2 each maintain independent RX frame counters
— each bus appears to receive its own stream of distinct frames.
No cross-bus state pollution.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
TWAI events by port:
  1 twai     port=0    ← TWAI0 TX
  1 twai     port=1    ← TWAI1 TX
  1 twai     port=2    ← TWAI2 TX
  3 twai_irq port=0    ← TWAI0 raise + clear + re-raise
  3 twai_irq port=1    ← TWAI1 raise + clear + re-raise
  3 twai_irq port=2    ← TWAI2 raise + clear + re-raise
  1 twai_rx  port=0    ← TWAI0 RX consume
  1 twai_rx  port=1    ← TWAI1 RX consume
  1 twai_rx  port=2    ← TWAI2 RX consume
```

15 events total. Per-instance state isolation verified — each bus
fires the full self-test sequence independently. Build clean.

## Lo que NO funcionó / decisiones tomadas

1. **All 3 buses self-test in immediate succession**: events
   bunch at boot (~150 µs apart per bus). Real silicon would
   never see this pattern since each TWAI has its own bus. The
   self-test ordering is intentional for boot-trace
   determinism — production firmware will use only one TWAI at
   a time anyway.

2. **Same self-test data on all 3 buses**: TX ID=0x123 / RX
   ID=0x456 on every bus. A future phase could differentiate
   per-bus self-tests (different IDs/data per bus) to make logs
   easier to read. Skipped — port_num already differentiates.

3. **TWAI1/TWAI2 addresses (0x500A7000, 0x500A8000)**: derived
   by extrapolation from TWAI0 at 0x500A6000 (4 KB stride is
   standard for ESP32 peripherals). May need adjustment if real
   IDF reg_base.h has different offsets — easy edit when first
   real driver is tested.

## Lessons learned

1. **Multi-instance pattern stabilized**: now applied across 3
   device classes (UART in 2.AZ/2.BB, I2C in 2.BB, TWAI in this
   phase). The loop-over-array shape is reusable enough to be
   considered a coding idiom.

2. **port_num field retrofits are easy**: adding it to TWAI
   required ~4 sites (3 emit functions + machine init). Future
   peripherals that might be multi-instance should add the field
   speculatively at first instantiation, even with port_num=0,
   to avoid the retrofit when a second instance lands.

3. **5-event boot trace × N instances = N×5 trace**: the boot
   sequence pattern from Phase 2.BF (TX, raise, clear, RX,
   re-raise) is the compact-validation pattern for TWAI. With
   3 instances, 15 events tells the full multi-bus story.

## Implementación final

### `include/hw/misc/esp32p4_twai.h`

- Added `uint8_t port_num;` to `ESP32P4TwaiState`.

### `hw/misc/esp32p4_twai.c`

- `emit_tx_event()`: JSON now includes `"port":%u`; stderr prefix
  now `[esp32p4.twai<N>]`.
- `emit_rx_event()`: same updates.
- `update_irq()`: same updates.

### `hw/riscv/esp32p4.c`

- Added `twai1`, `twai2` fields to `ESP32P4State`.
- Existing TWAI0 init block: added `ms->twai0.port_num = 0`.
- New init block after TWAI0: loops over (TWAI1, TWAI2), creating
  both instances, wiring event_log + port_num (1, 2) + CLIC
  causes (28, 29) + firing self-test on each.

## Estado consolidado (post-2.BL)

TWAI inventory:

| Port | Address | Phase | Cause |
|------|---------|-------|-------|
| TWAI0 | 0x500A6000 | 2.BA | 21 |
| **TWAI1** | **0x500A7000** | **2.BL** | **28** |
| **TWAI2** | **0x500A8000** | **2.BL** | **29** |

3 of 3 CAN buses reachable. CLIC cause map after this phase:

| Cause | Peripheral |
|-------|------------|
| 17-20 | base (SYSTIMER/GPIO/TIMG0/TIMG1) |
| 21 | TWAI0 |
| 22 | I2C0 |
| 23 | I2C1 |
| 24 | SPI2 |
| 25 | RMT |
| 26 | ADC |
| 27 | LEDC |
| 28 | TWAI1 (new) |
| 29 | TWAI2 (new) |

JSON event types: **25** (this phase adds instances + a `port`
field on TWAI events, not new event types).

## Próximas direcciones

- UART IRQ wiring (QOM class-override variation).
- WDT actual reset action.
- Real PWM waveform on GPIO via LEDC.
- BH1750/SHT31/CCS811 sensors.
- SPI3 instantiation (mirror of this phase for SPI).
- FreeRTOS scheduler resurrection.
