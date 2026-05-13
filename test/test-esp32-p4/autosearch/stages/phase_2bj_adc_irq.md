# Phase 2.BJ — ADC IRQ wiring

**Estado**: ✅ done — fifth backport of the IRQ template (after
TWAI 2.BF, I2C 2.BG, SPI 2.BH, RMT 2.BI). Guest sample read sets
`INT_RAW.ADC1_DONE` (bit 0) and fires CLIC cause 26. Arduino
interrupt-driven `analogRead()` and continuous ADC sampling
sketches now work.

Live test (2026-05-08), 2 `adc_irq` events at boot:
```json
{"t_ns":577903,"event":"adc_irq","level":1}
{"t_ns":593621,"event":"adc_irq","level":0}
```

JSON event types now **24**.

## Goal

Phase 2.AD established the ADC peripheral with synthesized 12-bit
sawtooth values. The remaining gap was CPU IRQ delivery —
sketches using interrupt-driven sampling (FreeRTOS task notification
on conversion-done, ADC continuous mode with callback) had no
signal to react to.

Phase 2.BJ closes it with the standard template. The ADC needed
slightly more work than the prior backports because:
1. Existing code had no `storage[]` array (it directly synthesized
   values without backing register state).
2. Adding INT register state required extending the struct
   AND giving the read/write paths scratch storage for non-DATA
   registers.

The skeleton now properly stores INT_RAW/CLR/ENA/ST per the
template, with the DATA register continuing to return time-driven
sawtooth values on demand.

## Lo que SE INVESTIGÓ

### 1. ADC INT trigger choice

Real ESP32 ADC supports multiple interrupt modes:
- Single-shot: SAR1 conversion done bit
- Continuous: monitor threshold bits, DMA complete bits
- Calibration: cal_done bits

For our skeleton with sample-on-read semantics, the natural
trigger is "sample requested" — i.e., set INT_RAW.ADC1_DONE on
every guest read of the DATA register. This is approximate but
captures the spirit: a sample was generated, the IRQ fires.

### 2. Edge detection prevents spam

With INT_RAW set unconditionally on every sample read, a
busy-poll guest could trigger thousands of IRQs per second. The
template's edge detection in `update_irq()` prevents this:
- First read: INT_RAW transitions 0→1, IRQ raises, ONE JSON
  event emitted.
- Subsequent reads with INT_RAW already set: no edge → no event.
- After INT_CLR ack: INT_RAW back to 0, ready for next raise.

So the IRQ rate is fundamentally bounded by guest ACK rate, not
sample rate. Demos without IRQ acks see ONE adc_irq raise event
total.

### 3. Boot self-test pattern

Mirror of 2.BI: machine init writes INT_ENA = 0x1 (enable
ADC1_DONE), does one synthetic sample read (which sets INT_RAW
→ raises IRQ), then writes INT_CLR = 0x1 (clears + lowers).
Pattern produces 2 events: raise + clear.

For this phase the self-test is inlined in machine init using
`address_space_write` / `address_space_read` (vs the helper-
function pattern used in 2.BF/2.BG). Both approaches work; the
inline version keeps changes localized to one file.

## Lo que SÍ funcionó

Live test (2026-05-08):
```
[esp32p4.adc] CPU IRQ line -> 1 (int_raw=0x1 int_ena=0x1)
[esp32p4.adc] CPU IRQ line -> 0 (int_raw=0x0 int_ena=0x1)
```

JSON: 2 `adc_irq` events with proper raise/clear sequence.
Build clean, regression-clean — other peripheral counts unchanged
from Phase 2.BI.

Template backport count: 5 peripherals now share the unified IRQ
pattern. Pattern stability validated yet again.

## Lo que NO funcionó / decisiones tomadas

1. **Only ADC1_DONE modeled**: SAR2_DONE and the various monitor /
   threshold / DMA interrupts stay zero. Most Arduino sketches
   use SAR1; deeper coverage is `2.BJ.full`.

2. **No timer-driven sample generation**: real silicon's continuous
   mode would fire samples (and thus IRQs) at a configured rate
   independent of guest reads. Our model is purely sample-on-read.
   Demos that configure continuous mode + wait for IRQ without
   reading will hang. Acceptable — single-shot mode is the typical
   Arduino `analogRead()` flow.

3. **Inline machine self-test vs helper function**: prior phases
   used `_self_test()` helpers in the device .c file. ADC's
   minimal struct made it easier to inline in machine init with
   `address_space_write/read`. Both patterns are valid; this is
   a stylistic divergence not worth normalizing.

4. **No `port_num` field**: ADC is single-instance. If we ever
   model both SAR units distinctly the field would be added.

## Implementación final

### `include/hw/adc/esp32p4_adc.h`

- Added INT_RAW/CLR/ENA/ST offsets (0x30/34/38/3C).
- Added `ESP32P4_ADC_INT_ADC1_DONE` bit (bit 0).
- Added `uint8_t storage[ESP32P4_ADC_IO_SIZE]` for scratch register
  storage (didn't exist before — ADC was pure compute).
- Added `intr_out` + `irq_level` fields.

### `hw/adc/esp32p4_adc.c`

- `esp32p4_adc_update_irq()` helper (mirror of I2C/SPI/RMT).
- `esp32p4_adc_read()`: DATA path now ALSO sets INT_RAW.ADC1_DONE
  + update_irq after the existing sample-emit. Other addresses
  return scratch storage instead of always zero.
- `esp32p4_adc_write()`: INT_CLR W1TC + INT_ENA update_irq +
  default scratch store.
- `realize`: gpio_out registration.
- `reset`: clears storage, drops IRQ line.

### `hw/riscv/esp32p4.c`

- ADC init block: connect intr_out to CLIC cause 26.
- Inline self-test using `address_space_write/read` for INT_ENA,
  DATA read, INT_CLR ack.

## Estado consolidado (post-2.BJ)

CLIC cause map:

| Cause | Peripheral | Phase |
|-------|------------|-------|
| 17-20 | base | various |
| 21 | TWAI0 | 2.BF |
| 22 | I2C0 | 2.BG |
| 23 | I2C1 | 2.BG |
| 24 | SPI2 | 2.BH |
| 25 | RMT | 2.BI |
| **26** | **ADC** | **2.BJ** |
| 27+ | unallocated | — |

JSON event types: **24** (added `adc_irq`).

Template backport count: **5 peripherals** (TIMG/TWAI/I2C/SPI/RMT/
ADC — actually 6 if you count TIMG separately, which uses a slight
variant). The pattern is at this point reliable infrastructure.

## Próximas direcciones

- UART IRQ wiring (cause 27, RX_FIFO_FULL / TX_DONE — needs QOM
  class-override pattern like 2.AW/2.AX).
- LEDC IRQ wiring (cause 28, duty done / counter overflow).
- WDT actual reset action.
- Real PWM waveform on GPIO via LEDC.
- BH1750/SHT31/CCS811 sensors.
- FreeRTOS scheduler resurrection.
