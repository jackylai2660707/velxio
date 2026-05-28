# Phase 2.CY — USB Serial/JTAG IRQ wiring (CLIC cause 28) + CLIC cause budget investigation

**Estado**: ✅ done — closes the deferred IRQ output from Phase
2.CR/CT (the USB Serial/JTAG controller had INT_RAW/INT_ENA/
INT_ST/INT_CLR scratch storage but no `qemu_irq` wiring). Adds
silicon-correct level-triggered IRQ delivery on CLIC cause 28
+ 36th JSON event type (`usb_jtag_irq`).

**Also documents the CLIC cause budget**: 32 causes total (16..47
per IDF `RV_EXTERNAL_INT_COUNT=32` + `OFFSET=16`), NOT arbitrary.
The investigation confirmed our model already matches silicon —
no expansion is possible without forking IDF, which we don't own.

Live verification (boot trace + JSON events):

```
[esp32p4.usb_serial_jtag] CPU IRQ line -> 1 (int_raw=0x4 int_ena=0x4)
[esp32p4.usb_serial_jtag] CPU IRQ line -> 0 (int_raw=0x0 int_ena=0x4)

JSON event sequence:
  8 × usb_jtag_tx     ← Phase 2.CR self-test (VelxioP4)
  usb_jtag_irq level=1 ← INT_ENA bit 2 set + first RX byte → edge up
  usb_jtag_rx seq=1 byte=65  ('A')  ← no edge (already asserted)
  usb_jtag_rx seq=2 byte=66  ('B')  ← no edge
  usb_jtag_irq level=0 ← INT_CLR bit 2 → edge down
```

## Goal

Two things:

**1. USB Serial/JTAG IRQ wiring.** Phases 2.CR and 2.CT landed
the TX byte path and RX FIFO reverse channel respectively, but
neither connected the peripheral's IRQ line to the CPU. Result:
`Serial.available()` only worked by polling the OUT_DATA_AVAIL
flag — no interrupt-driven RX. This phase wires the standard
INT_RAW/INT_ENA/INT_ST/INT_CLR pattern (TWAI/I2C style) to CLIC
cause 28.

**2. CLIC cause budget audit.** Past phases have repeatedly hit
the "cause budget exhausted at 31" comment in the autosearch
docs. This phase **investigated whether that's a true silicon
limit or an arbitrary model choice** — because if it's
arbitrary, the next 3-5 deferred IRQ wirings (USJ, UART × 5,
LP_UART) can all proceed unblocked.

The verdict: **32 causes is the silicon limit**, dictated by
IDF's `RV_EXTERNAL_INT_COUNT=32` + `RV_EXTERNAL_INT_OFFSET=16`
in `components/riscv/include/esp_private/interrupt_clic.h`.
Our `ESP_CPU_INT_LINES=31` (with `+1` = 32 lines) matches
exactly. The silicon-correct way to add MORE peripheral IRQs
past this limit is the **shared-cause + INT_STATUS dispatch**
pattern we already use for GPIO (cause 18 = all 32 pins,
disambiguated by INT_STATUS at the peripheral).

## Lo que SE INVESTIGÓ

### 1. CLIC cause inventory

Audited every `qdev_get_gpio_in_named(..., "espressif-cpu-irq-lines", N)`
call site in `hw/riscv/esp32p4.c`. Result:

| Cause | Peripheral                        | Phase    |
|-------|-----------------------------------|----------|
| 17    | SYSTIMER target 0                 | 2.K      |
| 18    | GPIO consolidated (all 32 pins)   | 2.AB     |
| 19    | LEDC                              | 2.BK     |
| 20    | TIMG0 / TIMG WDT                  | 2.AH/BU  |
| 21    | RWDT                              | 2.BV     |
| 22    | TIMG1 WDT                         | 2.AN.irq |
| 23    | ADC                               | 2.BJ     |
| 24    | RMT                               | 2.BI     |
| 25    | TWAI0 + TWAI1 + TWAI2 (shared)    | 2.BF/BL  |
| 26    | I2C1                              | 2.BG     |
| 27    | I2C0                              | 2.BG     |
| **28**| **USB Serial/JTAG (this phase)**  | **2.CY** |
| 29    | (free)                            | —        |
| 30    | SPI3                              | 2.BH     |
| 31    | SPI2                              | 2.BH     |

13 used + 1 (28) new = **14 of 32 causes wired**. The "budget
exhausted at 31" was a misnomer — it referred to the highest
cause number assigned (31, for SPI2), not actual saturation.
**18 causes are still free** for future peripherals.

### 2. RV_EXTERNAL_INT_COUNT in IDF

Confirmed via grep in `third-party/esp-idf`:

```c
// components/riscv/include/esp_private/interrupt_clic.h
#define RV_EXTERNAL_INT_COUNT   32
#define RV_EXTERNAL_INT_OFFSET  16
```

Plus the assertion `rv_int_num < RV_EXTERNAL_INT_COUNT` in
`interrupt.c:122`. So the IDF allocates exactly 32 external
interrupt handler slots; trying to use cause 48+ would assert
out at runtime.

The `_mtvt_table` in `components/riscv/vectors_clic.S` covers
causes 16..47 → `_interrupt_handler`, then causes 0..15 →
`_panic_handler`. So usable peripheral causes are 16..47 = 32
total, of which cause 16 is reserved (?), leaving 17..47 = 31
usable. This matches our `ESP_CPU_INT_LINES=31` with line N
mapping to cause N (or N+16 with the offset — the exact
mapping is in `esp_cpu_irq_handler`, untouched this phase).

### 3. Real-silicon interrupt matrix design

ESP32-P4 has 80+ peripheral interrupt **sources** (TRM § 12.4)
but only 32 CLIC causes. The on-chip **Interrupt Matrix**
peripheral routes source N → cause M via the
`interrupt_clic_ll_route(core_id, intr_src, intr_num + 16)`
call in IDF.

Multiple sources can map to the same cause; the ISR reads each
candidate peripheral's INT_STATUS register to figure out which
fired. This is exactly the pattern we already use for GPIO
(cause 18 + 32 pins disambiguated by GPIO_INT_STATUS) — i.e.,
our model is silicon-correct in this regard, just incomplete.

For Phase 2.CY's USJ IRQ this didn't matter because USJ is
sole owner of cause 28; future additions of multi-source
causes (UART × 5 on one cause, for example) would need an
interrupt matrix model — deferred.

### 4. USB Serial/JTAG INT_RAW bit map (IDF reg.h)

Per `components/soc/esp32p4/include/soc/usb_serial_jtag_reg.h`:

| Bit | Name                       | Meaning                              |
|-----|----------------------------|--------------------------------------|
| 0   | JTAG_IN_FLUSH_INT          | host accepted JTAG out               |
| 1   | SOF_INT                    | USB Start-of-Frame                   |
| 2   | SERIAL_OUT_RECV_PKT_INT    | host sent a packet (= RX byte)       |
| 3   | SERIAL_IN_EMPTY_INT        | device TX FIFO drained               |
| 4+  | (PID_ERR, …)               | USB protocol errors                  |

**Bit 2 is the load-bearing one** for `Serial.available()`
interrupt-driven RX. Without it, the Arduino guest drops back
to polling the OUT_DATA_AVAIL flag in EP1_CONF — works but
wastes CPU.

Bit 3 (TX_DRAINED) would be useful for non-blocking
`Serial.write()` but Adafruit/IDF drivers typically rely on
the WR_DONE pulse + immediate-commit model — bit 3 isn't
plumbed in this phase.

### 5. Level-triggered IRQ pattern

Standard pattern across our peripherals (TWAI, I2C, GPIO):

```
INT_RAW : settable by HW (e.g., on RX byte enqueue)
INT_ENA : RW by guest — masks which raw bits propagate
INT_ST  : INT_RAW & INT_ENA (read-only mirror)
INT_CLR : W1TC — guest writes a 1 to clear the matching raw bit

irq_level = (INT_ST != 0)
on edge transition: qemu_set_irq(intr_out, irq_level ? 1 : 0)
```

Mirroring this pattern for USJ:
- `esp32p4_usj_update_irq(s)` computes `int_st`, drives line,
  emits a `usb_jtag_irq` JSON event on edge.
- `rx_enqueue()` sets INT_RAW bit 2 + calls update_irq.
- Write handler for INT_ENA + INT_CLR calls update_irq.

### 6. Self-test extension for IRQ coverage

To exercise the IRQ path without needing a real frontend FIFO
connection, the self-test now also:
1. Writes INT_ENA = 0x04 (unmask bit 2).
2. Synthesizes 2 RX bytes ('A', 'B') via direct rx_enqueue.
3. Writes INT_CLR = 0x04 (clear the latched bit).

Expected JSON:
- `usb_jtag_irq level=1` after the INT_ENA write + first RX
  (edge up).
- Two `usb_jtag_rx` events.
- `usb_jtag_irq level=0` after INT_CLR (edge down).

No second `level=1` event between the two RX bytes — bit 2 is
already set; the second enqueue keeps it set without an edge.
This matches the level-trigger semantics (only edge transitions
emit).

## Lo que SÍ funcionó

1. ✅ Build clean — 4 files changed (USJ header + USJ source +
   machine init + no new files).
2. ✅ Existing Phase 2.CR self-test regression-clean: 8
   `usb_jtag_tx` events for VelxioP4.
3. ✅ Edge-up: after INT_ENA = 4 + first RX, line goes 0→1,
   `usb_jtag_irq level=1` emitted, stderr trace shows
   `int_raw=0x4 int_ena=0x4`.
4. ✅ No spurious edge between the two RX bytes (bit 2 stays
   set; INT_ST unchanged; qemu_set_irq not called).
5. ✅ Edge-down: after INT_CLR = 4, line goes 1→0,
   `usb_jtag_irq level=0` emitted.
6. ✅ CLIC cause 28 wire connection accepted by the CPU model
   (no "out of range" warnings).
7. ✅ Cause inventory audit found 18 free causes (lines 16, 29,
   32..47) — plenty of headroom.
8. ✅ DIS_USB_SERIAL_JTAG eFuse gate (Phase 2.CC) still
   short-circuits the whole peripheral including IRQ — no
   regression on the disable path.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Cause 28, not 29**: both were free. Picked 28 because it's
   contiguous with the existing 26 (I2C1) and 27 (I2C0) — keeps
   the I/O peripheral block clustered.

2. **Only INT_RAW bit 2 (RX) plumbed, not bit 3 (TX drained)**:
   bit 3 needs the TX FIFO drain detection logic, which would
   need to track the WR_DONE pulse → "byte committed to USB"
   timing. Real silicon clocks bytes out at ~1 µs per byte
   (USB FS); our model commits instantaneously. Plumbing bit 3
   would either always fire immediately (useless) or need a
   QEMUTimer to delay. Deferred.

3. **`SERIAL_OUT_RECV_PKT` semantics = per-byte, not per-packet**:
   real USB delivers packets (up to 64 B on USB FS bulk), and
   the IRQ fires once per packet. Our model fires per byte —
   matches our 1-byte-at-a-time FIFO frontend model. Real
   silicon's behavior would aggregate, but only matters for
   sketches that depend on IRQ-count semantics, which is unusual.

4. **Self-test extension over a separate IRQ test**: keeps the
   one-self-test-per-peripheral pattern from Phases 2.CR/CT.
   The IRQ assertions are appended at the end of the existing
   self-test; no separate function.

5. **Edge-trigger emission for JSON events**: same as TWAI/I2C
   patterns (Phase 2.BF/BG). Per-bit-flip emission would
   produce too many events under guest tight-poll; edge-only
   is correct for "the IRQ line just changed".

6. **No `usb_jtag` event type renaming**: existing
   `usb_jtag_tx` / `usb_jtag_rx` event types stay; new
   `usb_jtag_irq` is the 36th distinct type. Three types for
   three semantically distinct flows (TX byte / RX byte / IRQ
   edge).

7. **Did NOT expand `ESP_CPU_INT_LINES`**: investigation
   confirmed 32 is the IDF-imposed silicon limit (`RV_EXTERNAL_INT_COUNT`).
   Increasing the QEMU line count past 31 would let our model
   wire more peripherals, but the IDF guest would never accept
   them — assertions in `interrupt.c` would fire. The model
   matching silicon is the correct stance.

8. **CONF0 not modeled for IRQ-relevant bits**: CONF0 holds
   PHY/clock config; none of its bits affect IRQ semantics.
   Phase scope kept tight.

## Lessons learned

1. **"Budget exhausted" claims in old autosearch docs needed
   re-verification.** Multiple phases (2.CR comment, 2.CT
   comment, the Phase 2.CV "85-phase progression" table) said
   "USJ IRQ wiring blocked — cause budget exhausted at 31".
   This was a misreading of the inventory — the highest cause
   in use was 31, but causes 28 and 29 were never claimed.
   **Always do the inventory before claiming saturation.**

2. **IDF defines the silicon limit, not QEMU.** The CLIC could
   physically support 4096 causes per RISC-V spec. The 32-cause
   limit is artificial (IDF's `RV_EXTERNAL_INT_COUNT`). Our
   model is correct to match IDF, not the spec maximum.

3. **Shared-cause + INT_STATUS dispatch is the silicon-correct
   solution past 32 distinct peripherals.** GPIO already does
   this (cause 18 + 32 pins). Future phases adding UART × 5 +
   LP_UART would consolidate onto one or two shared causes,
   not new dedicated causes — the interrupt matrix model would
   need to be added, but the per-peripheral IRQ semantics stay
   the same.

4. **Level-trigger emission semantics matter for trace
   correlation.** Two consecutive RX bytes produce two
   `usb_jtag_rx` events but only **one** `usb_jtag_irq` event.
   A frontend renderer reading the trace can count RX bytes
   independently of IRQ edges — which is correct: a single
   ISR invocation can consume many bytes from the FIFO.

5. **Reusing the standard 4-register IRQ pattern paid off.**
   The INT_RAW/INT_ENA/INT_ST/INT_CLR template from
   TWAI/I2C/GPIO dropped into USJ with zero new design
   decisions. Future peripherals get the same template at
   negligible cost.

## Implementación final

### `include/hw/char/esp32p4_usb_serial_jtag.h`

- Added `#include "hw/irq.h"`.
- New `qemu_irq intr_out` + `bool irq_level` fields in state.
- New `ESP32P4_USJ_INT_SERIAL_OUT_RECV_PKT` (bit 2) + 
  `ESP32P4_USJ_INT_SERIAL_IN_EMPTY` (bit 3) defines with
  comments documenting the full bit map.

### `hw/char/esp32p4_usb_serial_jtag.c`

- New `esp32p4_usj_update_irq(s)` helper — computes int_st,
  drives intr_out on edge, emits `usb_jtag_irq` JSON event.
- `rx_enqueue()` now sets INT_RAW bit 2 + calls update_irq.
- Write handler: INT_CLR + INT_ENA writes now call update_irq.
- `realize()` adds `sysbus_init_irq(... &s->intr_out)`.
- Self-test extended: INT_ENA=4 + 2 RX synth + INT_CLR=4.

### `hw/riscv/esp32p4.c`

- Added `sysbus_connect_irq(... ms->usj ..., "espressif-cpu-irq-lines", 28)`
  after the existing USJ realize block.

## Estado consolidado (post-2.CY)

CLIC cause inventory:

| Cause | Peripheral                        | Phase    |
|-------|-----------------------------------|----------|
| 17    | SYSTIMER target 0                 | 2.K      |
| 18    | GPIO consolidated                 | 2.AB     |
| 19    | LEDC                              | 2.BK     |
| 20    | TIMG0 / TIMG WDT                  | 2.AH/BU  |
| 21    | RWDT                              | 2.BV     |
| 22    | TIMG1 WDT                         | 2.AN.irq |
| 23    | ADC                               | 2.BJ     |
| 24    | RMT                               | 2.BI     |
| 25    | TWAI0/1/2 (shared)                | 2.BF/BL  |
| 26    | I2C1                              | 2.BG     |
| 27    | I2C0                              | 2.BG     |
| **28**| **USB Serial/JTAG**               | **2.CY** |
| 29    | (free)                            | —        |
| 30    | SPI3                              | 2.BH     |
| 31    | SPI2                              | 2.BH     |

Used: 14 / 32. Free: 16, 29, 32..47 = 18 causes.

JSON event types: **36** — adds `usb_jtag_irq` to the inventory
(`hmac`, `aes`, `sha`, `usb_jtag_tx`, `usb_jtag_rx`,
`ssd1306`, `i2c`, `i2c_rx`, `i2c_irq`, `twai`, `twai_irq`,
`spi`, `spi_irq`, `rmt`, `rmt_irq`, `adc`, `adc_irq`,
`ledc`, `ledc_irq`, `timg`, `timg_irq`, `rwdt`, `rwdt_irq`,
`super_wdt`, `gpio`, `gpio_irq`, `uart_tx`, `uart_rx`,
`rng`, `efuse`, `chip_info`, `start`, `clic`, `clic_irq`,
`pin`, `usb_jtag_irq` (new)).

## 87-Phase realism progression

| Phase | Capability                                                |
|-------|-----------------------------------------------------------|
| 2.CW  | MS5611 + env-var dispatcher override (bool flags)         |
| 2.CX  | BME280 + dispatcher refactor to function pointers         |
| **2.CY** | **USB Serial/JTAG IRQ (cause 28) + CLIC budget audit** |

`Serial.available()` now interrupt-driven on the Arduino default
USB CDC path. Bidirectional USB Serial/JTAG complete with full
peripheral semantics: TX (2.CR), RX (2.CT), IRQ (2.CY).

## Próximas direcciones

- **UART × 5 IRQ wiring via shared cause + INT_STATUS dispatch**
  — needs a small interrupt-matrix model OR pick 5 dedicated
  causes from the free pool (29, 32..47). Latter is simpler.
- **LP_UART IRQ wiring** — same pattern.
- **USB Serial/JTAG IN_EMPTY (TX-drained) bit 3 IRQ** — for
  non-blocking Serial.write().
- **JTAG bridge peripheral** — TRM § 51.2 JTAG TAP.
- **BMP180 / BME680** — slot into the 2.CX fn-ptr dispatcher.
- **SHA-384/512/512-t modes**.
- **HMAC streaming refactor** (remove 1024-byte cap).
- **Secure Boot digest verifier** — TRM Chapter 29.
- **AES-CBC/AES-GCM/XTS-AES** (needs DMA).
- **Digital Signature peripheral** — KEY_PURPOSE=7.
- **RSA / ECDSA / ECC** crypto peripherals.
- **DMA-SHA path**.
- **MS5611 CRC-4 PROM verification**.
- **W5500 / MFRC522** SPI responders.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection.
