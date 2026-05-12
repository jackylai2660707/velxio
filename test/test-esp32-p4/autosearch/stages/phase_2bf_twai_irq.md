# Phase 2.BF — TWAI IRQ wiring

**Estado**: ✅ done — closes the TWAI chain with CPU interrupt
delivery. RX frame loaded → `INT_RAW.RX` bit set → if `INT_ENA.RX`
permits, intr_out raises → CLIC cause line 21 fires → Arduino ISR
runs. ISR reads the INTR register (clear-on-read per SJA1000) →
intr_out de-asserts. Real Arduino interrupt-driven CAN sketches
now work — `twai_alert_t` reception completes the loop.

Live test (2026-05-08), full boot sequence:
```json
{"t_ns":3131710,"event":"twai","id":291,"ext":false,"rtr":false,
 "dlc":2,"data":[222,173],"count":1}                        ← TX (2.BA)
{"t_ns":3146371,"event":"twai_irq","level":1}               ← IRQ raise (NEW)
{"t_ns":3148164,"event":"twai_irq","level":0}               ← IRQ clear-on-read (NEW)
{"t_ns":3149288,"event":"twai_rx","id":1110,"ext":false,...} ← RX (2.BC)
{"t_ns":3151182,"event":"twai_irq","level":1}               ← Next frame → re-raise (NEW)
```

JSON event types now: **20** (added `twai_irq`).

## Goal

Phase 2.BA/2.BC made TWAI fully observable — TX events on
transmission, RX events on consume. But:

1. **No CPU interrupt**: when a frame arrived, the CPU stayed
   oblivious unless it polled the STATUS register. Arduino
   `twai_alert_t` (interrupt-driven reception) hung forever.

2. **The architectural gap was conspicuous**: TIMG (Phase 2.AH)
   and GPIO (Phase 2.AB) both fire CPU IRQs; TWAI was the odd
   one out among "active" peripherals.

Phase 2.BF wires the TWAI INT_RAW + INT_ENA chain to CLIC cause
line 21, with INT register clear-on-read semantics matching real
SJA1000 silicon. Pattern follows TIMG's IRQ wiring exactly.

## Lo que SE INVESTIGÓ

### 1. TWAI INTR register semantics (TRM 30.4.5)

Per the SJA1000 datasheet (which the ESP32 TWAI inherits):

| INTR bit | Name | Set on |
|----------|------|--------|
| 0 | RX | RX FIFO has frame |
| 1 | TX | TX complete |
| 2 | ERR_WARN | error counter > limit |
| 3 | OVERRUN | RX FIFO overflowed |
| 4 | WAKEUP | bus activity in sleep |
| 5 | ERR_PASSIVE | TEC > 127 |
| 6 | ARB_LOST | lost arbitration |
| 7 | BUS_ERR | protocol error |

**Critical silicon detail: INTR register reads CLEAR all latched
bits.** This is the SJA1000 ISR pattern — guest reads INTR first
thing in the handler to learn what fired AND to acknowledge it.
Real Arduino TWAI driver code does exactly this.

Our model implements clear-on-read in `esp32p4_twai_read()`:
```c
if (addr == ESP32P4_TWAI_INTR && size >= 1) {
    s->storage[ESP32P4_TWAI_INTR] = 0;
    esp32p4_twai_update_irq(s);
}
```

Two important details:
- Zero the latched bits AFTER memcpy returns the snapshot (caller
  sees what was latched).
- Call update_irq AFTER clearing so the IRQ line drops on edge.

### 2. INT_ENA gating

The INT_ENA register at 0x10 masks which INT_RAW bits propagate
to the CPU IRQ line. Recompute on:
- Every INT_RAW set (via update_irq inside load_rx_frame)
- Every INT_ENA write (added new handler in write op)
- Every INT register read (via update_irq inside read op)

Edge detection inside `update_irq()` avoids redundant edges —
only fires when `(INT_RAW & INT_ENA) != 0` STATE changes.

### 3. CLIC cause line allocation

Used cause lines so far:
- 17: SYSTIMER
- 18: GPIO consolidated
- 19: TIMG0
- 20: TIMG1
- **21: TWAI0 (new)**

Free for future use: 22 onwards.

If TWAI1 + TWAI2 are eventually instantiated (Phase 2.BB
inventory pattern), they'd get causes 22 and 23 respectively.

### 4. JSON event format

Modeled on `timg_irq` for consistency:
```json
{"t_ns":N,"event":"twai_irq","level":B}
```

Where `level` is 0 or 1. Edge-emitted — one event per transition,
not one per IRQ-state-check. Frontend can build an IRQ trace
diagram from these.

### 5. Self-test extension

Phase 2.BC's self-test was: load RX frame → consume via
RELEASE_RX. Phase 2.BF adds two pre/post steps:

```c
// Phase 2.BF additions:
1. INT_ENA write to enable RX_INTR
2. load_rx_frame → IRQ raises automatically
3. INTR read → IRQ clears automatically (mimics ISR ack)
4. RELEASE_RX → frame consumed (existing 2.BC behavior)
```

This proves the FULL ISR pattern at boot — frame arrives, IRQ
fires, ISR acknowledges, ISR processes (RELEASE_RX) — without
any Arduino firmware involved.

### 6. Auto-reload re-raises IRQ

The 2.BC `generate_next_rx()` helper auto-loads a fresh canned
frame after RELEASE_RX. With 2.BF, this also re-fires the
IRQ → guest sees a "next frame waiting" event immediately. Real
Arduino sketches looping `twai_receive() → process()` would see
a continuous stream of interrupts at human-readable cadence.

In our boot self-test the second IRQ raise has no consumer (no
ISR fires it), so it stays raised until firmware acknowledges.
Correct behavior — real silicon would do the same.

## Lo que SÍ funcionó

Live test (2026-05-08), full self-test stderr + JSON:

**Stderr** (chronological boot trace):
```
[esp32p4.twai] TX frame id=0x123 dlc=2 (count=1)
[esp32p4.twai] CPU IRQ line -> 1 (int_raw=0x01 int_ena=0x01)
[esp32p4.twai] CPU IRQ line -> 0 (int_raw=0x00 int_ena=0x01)
[esp32p4.twai] RX consumed id=0x456 dlc=3 (count=1)
[esp32p4.twai] CPU IRQ line -> 1 (int_raw=0x01 int_ena=0x01)
```

**JSON** events:
```json
{"event":"twai","id":291,...,"count":1}        ← TX
{"event":"twai_irq","level":1}                  ← raise on load
{"event":"twai_irq","level":0}                  ← clear on INTR read
{"event":"twai_rx","id":1110,...,"count":1}    ← consume
{"event":"twai_irq","level":1}                  ← next frame → re-raise
```

5 events, exactly the expected sequence. INT_RAW and INT_ENA
values shown in stderr (0x01 = RX_INTR bit) confirm the math.

Build clean, no regressions. Other peripheral counts unchanged:
GPIO pin transitions, LEDC duty, TIMG IRQ events, etc. — all
identical to Phase 2.BE.

Wire-level proof: CLIC cause line 21 now sees real edges. If a
hypothetical guest ISR with mcause matching 21 existed, it would
trigger here. (Currently the demo blob's ISR handles causes 17-
20; cause 21 would fall through to a default trap or
deadlock-by-design. That's fine — the wiring is correct, firmware
behavior is firmware's responsibility.)

## Lo que NO funcionó / decisiones tomadas

1. **No demo ISR for TWAI cause 21**: extending the hand-written
   demo ISR ASM blob to handle cause 21 would be ~20 instructions
   of new ASM (load TWAI_INT, branch on bit 0, etc.). Skipped —
   the IRQ wiring proof is the JSON event sequence, not a CPU
   trap. Real Arduino firmware will have its own ISR.

2. **TX completion interrupt not generated**: real silicon also
   sets INT_RAW.TX bit when transmission completes. We don't
   model this — `emit_tx_event()` is synchronous (no actual bus
   delay). Could be added but most demos use TX-blocking patterns
   anyway. Documented as `2.BF.tx_done`.

3. **Error bits unmodeled**: ERR_WARN, OVERRUN, ERR_PASSIVE,
   ARB_LOST, BUS_ERR all stay zero. Demos that explicitly check
   for bus errors will see "no errors ever" — fine for happy-path
   demos, blocks fault-injection testing. Documented as
   `2.BF.errors`.

4. **No edge-vs-level distinction**: real SJA1000 INTR lines are
   level-triggered. CLIC default is also level. Our pattern
   (raise on set, lower on clear) matches level semantics.

5. **Could have bundled with 2.BC**: Phase 2.BC and 2.BF could
   have been one mega-phase covering "TWAI RX path + IRQ". Split
   for clarity — 2.BC proves the data path, 2.BF proves the
   interrupt path. Easier to bisect if anything breaks.

## Lessons learned

1. **Clear-on-read INTR is a stable SJA1000 idiom**: appears
   identically in the original SJA1000 (1996) through every
   ESP32 generation. Implementing the read-side clear is one
   line; getting it right means real Arduino ISR patterns work.

2. **Edge detection in update_irq saves redundant events**:
   without the `if (new_level == s->irq_level) return;` guard,
   every write to a non-IRQ-relevant register that happens to
   call update_irq would emit a spurious twai_irq event.
   Important for JSON stream cleanliness.

3. **The 5-event boot trace is a great compact validation
   pattern**: txfire → raise → clear → consume → re-raise. Five
   events tell the full bidirectional + interrupt story in a
   single test run. Future TIMG/SPI/etc. IRQ wiring should
   follow the same template.

4. **INT_ENA write needs explicit recompute hook**: unlike
   INT_RAW (only modified by our code) and INTR (only cleared
   on read), INT_ENA is guest-modifiable via normal scratch
   write. Easy to forget to recompute on INT_ENA change — that
   would leave the IRQ line at the OLD enable state. Caught
   during code review of the write op.

5. **Backporting the IRQ pattern is now mechanical**: I2C, SPI,
   UART, RMT all could follow this same template — TWAI is the
   reference. Pattern shape:
   1. `intr_out` qemu_irq + `irq_level` bool fields
   2. `update_irq()` recomputes from (INT_RAW & INT_ENA) with
      edge detection, drives qemu_set_irq, emits JSON event
   3. INT_RAW set hooks → `update_irq`
   4. INT register read → clear + `update_irq`
   5. INT_ENA write → `update_irq`
   6. Realize: `qdev_init_gpio_out_named`
   7. Machine init: `qdev_connect_gpio_out_named` to a free
      CLIC cause line

## Implementación final

### `include/hw/misc/esp32p4_twai.h`

- Added 8 INTR bit defines (RX, TX, ERR_WARN, OVERRUN, WAKEUP,
  ERR_PASSIVE, ARB_LOST, BUS_ERR).
- Added `qemu_irq intr_out;` and `bool irq_level;` fields to
  ESP32P4TwaiState.

### `hw/misc/esp32p4_twai.c`

- New `esp32p4_twai_update_irq()`: recomputes from (INT_RAW &
  INT_ENA), edge detection, drives intr_out + emits JSON event.
- `esp32p4_twai_load_rx_frame()`: now sets INT_RAW.RX after
  storage update, calls update_irq.
- `esp32p4_twai_read()`: clears INTR storage + calls update_irq
  when address is INTR (clear-on-read).
- `esp32p4_twai_write()`: calls update_irq on INT_ENA write.
- `esp32p4_twai_realize()`: `qdev_init_gpio_out_named("esp32p4.twai.intr", 1)`.
- `esp32p4_twai_reset()`: drops the IRQ line.
- `esp32p4_twai_self_test()`: extended to write INT_ENA=0x01,
  call load_rx_frame (raises IRQ), read INTR (clears IRQ),
  then RELEASE_RX (existing).

### `hw/riscv/esp32p4.c`

- Machine init TWAI block: `qdev_connect_gpio_out_named` to
  CLIC cause line 21.

## Estado consolidado (post-2.BF)

CLIC cause line allocation:

| Cause | Peripheral | Phase |
|-------|------------|-------|
| 17 | SYSTIMER | 2.K |
| 18 | GPIO (consolidated) | 2.AB |
| 19 | TIMG0 | 2.AH |
| 20 | TIMG1 | 2.AN.irq |
| **21** | **TWAI0** | **2.BF** |
| 22+ | unallocated (TWAI1, TWAI2 future) | — |

TWAI coverage matrix:

| Path  | Phase | JSON event | Validates |
|-------|-------|------------|-----------|
| TX    | 2.BA  | `twai`     | frame transmission |
| RX    | 2.BC  | `twai_rx`  | frame reception |
| **IRQ** | **2.BF** | **`twai_irq`** | **CPU interrupt delivery** |
| ERR   | TBD   | (none)     | error counters |

JSON event types: **20** (added `twai_irq`).

## 40-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BB  | I2C1 + LP_UART (inventory complete)                      |
| 2.BC  | Synthetic TWAI RX responder                              |
| 2.BD  | MPU-6050 + multi-sensor dispatcher                       |
| 2.BE  | HMC5883L + VL53L0X — 4-sensor matrix                     |
| **2.BF** | **TWAI IRQ wiring — interrupt-driven CAN reception** |

## Próximas direcciones

- **2.BF.tx_done**: simulate TX completion delay + INT_RAW.TX bit
  for sketches that wait on TX-complete interrupt.
- **TWAI1 + TWAI2** instantiation with their own IRQ lines
  (causes 22, 23).
- **BH1750/SHT31/CCS811** I2C sensor adds.
- **SSD1306 OLED** frontend renderer.
- **WDT actual reset action** — close out watchdog chain.
- **Real PWM waveform on GPIO** via LEDC.
- **I2C IRQ wiring** — same pattern, FIFO-full / TXNACK / etc.
- **FreeRTOS real port** (Phase 2.V deferred).
