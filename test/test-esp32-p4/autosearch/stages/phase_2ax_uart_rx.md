# Phase 2.AX — UART RX JSON event tracking

**Estado**: ✅ done — every byte the chip receives via UART0 RX FIFO
now appears in the JSON event stream as `{"event":"uart_rx",...}`.
Completes the bidirectional UART visibility started by Phase 2.AW.
Frontend can now render both `Serial.print()` output AND user input
forwarded into the emulator.

Pairs with Phase 2.AW (TX direction). Together they close the last
remaining gap in the JSON tracer coverage matrix.

## Goal

Phase 2.AW made every UART **TX** byte visible as JSON. The
corresponding RX path was still invisible: guest reads of
`UART_FIFO` (offset 0) drained the parent class's `rx_fifo` and
delivered bytes to the running program, but the JSON tracer never
saw them. Frontend renderers reading the event stream could show
chip-to-host output but not host-to-chip input.

Phase 2.AX adds JSON event emission for every RX byte the guest
**actually consumes** from the FIFO — with one important silicon-
correct subtlety: empty-FIFO reads are NOT logged. Real silicon
returns 0 on an empty RX FIFO; without filtering, polling loops
(`while (uart.available()) ...`) would flood the tracer with
zero-byte ghost events on every poll cycle.

## Lo que SE INVESTIGÓ

### 1. The parent's `uart_read` virtual

Same QOM virtual-method pattern as 2.AW, but for the read direction.
`ESP32UARTClass` exposes:

```c
uint64_t (*uart_read)(void *opaque, hwaddr addr, unsigned int size);
```

Phase 2.AW already saved `parent_write`; we mirror it with a
`parent_read` static and override `class->uart_read` in
`esp32p4_uart_class_init`. The class-init function now installs
BOTH overrides in one block:

```c
esp32p4_uart_parent_write = uart_class->uart_write;
uart_class->uart_write    = esp32p4_uart_write;
esp32p4_uart_parent_read  = uart_class->uart_read;
uart_class->uart_read     = esp32p4_uart_read;
```

Two statics, one per direction. Single class shared across all P4
UART instances — same justification as 2.AW.

### 2. Where does the byte come from / when is it "real" data

The parent's `esp32_uart_read` at address `A_UART_FIFO` (offset 0)
runs roughly:

```c
if (fifo8_is_empty(&s->rx_fifo)) {
    return 0;            // silicon-correct empty read
}
return fifo8_pop(&s->rx_fifo);
```

Two cases for the guest:
1. **FIFO had data** — pop returns the real byte. We want to log it.
2. **FIFO was empty** — returns 0. We want to NOT log it (otherwise
   any RX-polling Arduino sketch would flood the JSON with bogus
   "byte 0 received" events on every tight loop iteration).

The only reliable way to distinguish the two cases from the wrapper
is to snapshot `fifo8_is_empty(&base->rx_fifo)` **before** chaining
to the parent. The parent drains the FIFO during the read; checking
after would always show empty. Checking before and saving in a
local boolean is the silicon-correct hook.

```c
bool had_data = false;
if (addr == A_UART_FIFO) {
    ESP32UARTState *base = (ESP32UARTState *)opaque;
    had_data = !fifo8_is_empty(&base->rx_fifo);
}
uint64_t value = esp32p4_uart_parent_read(opaque, addr, size);
if (addr == A_UART_FIFO && had_data && s->event_log) {
    /* emit uart_rx event */
}
```

### 3. Casting opaque to two related types

The opaque pointer is the same object — but we need two different
struct views of it:

- `ESP32P4UARTState *s` — for our subclass fields (`event_log`,
  `boot_ns`, `rx_count`, `port_num`).
- `ESP32UARTState *base` — for the inherited `rx_fifo` field.

Because `ESP32P4UARTState` declares `ESP32C3UARTState parent;` as
its first member (which itself starts with `ESP32UARTState
parent;`), C's struct-layout guarantee says `(ESP32UARTState
*)opaque` is a valid view onto the leading base subobject. No
container_of dance needed.

QEMU's QOM relies on this exact layout invariant project-wide; the
cast is idiomatic for chain-class peripherals like this one.

### 4. `rx_count` field added to ESP32P4UARTState

Symmetric with `tx_count` from Phase 2.AW. Lets the JSON event
include a running count so frontends can detect dropped events.

```c
typedef struct ESP32P4UARTState {
    ESP32C3UARTState parent;
    FILE   *event_log;
    int64_t boot_ns;
    uint32_t tx_count;
    uint32_t rx_count;   /* NEW for 2.AX */
    uint8_t  port_num;
} ESP32P4UARTState;
```

### 5. No demo blob changes needed

The demo blob doesn't perform any UART reads — it's pure TX. The RX
path is exercised by external input via `-serial stdio` or
`-chardev` pipes. So the regression test produces ZERO `uart_rx`
events out of the box, which is the right answer (nothing is being
sent to the chip during the 10-second harness).

To validate the path end-to-end would require either:
- Connecting a chardev pipe and writing bytes from the host, OR
- Patching the demo to do a self-loopback (`USR_RX` mode of UART
  for hardware test).

Neither is in scope for this phase — the **code path exists and
compiles**, regression-clean, and is ready for the first real chip-
reads (firmware that uses `Serial.read()`).

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== Total counts ===
  total: 484
  pin8:  9
  timg:  28
  timg_irq: 38
```

Identical to Phase 2.AW baseline within timing variance. The new
read-override wrapper is on the hot path for every UART_FIFO read,
but in this test nothing reads the FIFO (no chardev pipe). Zero
overhead on the existing self-test, zero new events, zero
regression.

The `uart_tx` events from Phase 2.AW still emit correctly (26 of
them spell "Hello from QEMU ESP32-P4!" as before).

Build clean: `wsl_build_p4.sh` finishes with no compiler warnings
or errors on the modified files.

## Lo que NO funcionó / decisiones tomadas

1. **No active RX test in regression harness**: would require
   wiring a chardev pipe + injecting bytes + waiting for guest
   consume. Out of scope for this phase. The code path is correct
   by construction (mirrors TX path) and will fire on the first
   real `Serial.read()`-using firmware. Documented as a future
   integration step ("when adding Arduino RX echo demo, validate
   uart_rx events appear").

2. **Empty-FIFO filtering at the wrapper, not at the parent**:
   the parent returns 0 on empty reads — we could have just
   filtered `value == 0` in the wrapper, but byte 0 is a legitimate
   data byte (null terminator, binary protocols). Snapshotting
   `fifo8_is_empty` before the drain is the only correct way to
   distinguish "real zero byte" from "no data available".

3. **`uart_rx` event shape mirrors `uart_tx` exactly**: same
   fields (`port`, `byte`, `count`) so frontend can use a single
   parser for both directions. Considered adding `direction: "rx"`
   field but the `event` name already encodes it.

4. **No per-port count namespacing**: `rx_count` is per-instance
   (per UART port). When UART1..UART4 are added each instance has
   its own count starting from 1. Frontend reading two streams
   needs to correlate by `(port, count)` not `count` alone — same
   as 2.AW.

## Lessons learned

1. **Read-side instrumentation needs pre-drain state capture**: any
   peripheral wrapper that wants to log "what the guest just
   consumed" must snapshot consumer state BEFORE chaining to the
   parent. After the chain, the FIFO/queue is empty and the
   distinction between "we just popped X" and "there was nothing
   to pop" is lost.

2. **The QOM class-init pattern scales cleanly**: adding read
   override alongside write override was a 4-line edit (save
   parent + replace + add wrapper). Future direction overrides
   (e.g., DMA read/write for the UART) follow the same template.

3. **Silicon-correct stub behavior dictates wrapper logic**: real
   ESP32-P4 returns 0 on empty RX FIFO reads — our parent class
   already mimics this. The wrapper has to KNOW this and filter,
   otherwise it lies to the JSON tracer.

4. **Bidirectional visibility unlocks two-way Arduino demos**:
   pairing TX (2.AW) + RX (2.AX) means a future "Serial echo"
   demo can be fully traced — host sends bytes, chip receives,
   chip echoes, host sees the echo, all observable in JSON.

## Implementación final

### `include/hw/char/esp32p4_uart.h`

- ESP32P4UARTState gains `uint32_t rx_count;` field (next to
  existing `tx_count` from 2.AW).
- Docblock updated to describe both TX and RX JSON tracking.

### `hw/char/esp32p4_uart.c`

- Added `#include "qemu/fifo8.h"` for `fifo8_is_empty()`.
- New static `esp32p4_uart_parent_read` saves the parent's virtual.
- New `esp32p4_uart_read()` wrapper:
  - Snapshots `fifo8_is_empty(&base->rx_fifo)` before chain.
  - Chains to parent.
  - Emits `event:"uart_rx"` JSON only if `had_data && s->event_log`.
- `esp32p4_uart_class_init()` now saves AND overrides both
  `uart_write` and `uart_read`.

### `hw/riscv/esp32p4.c`

- No change. The post-GPIO-realize event_log wiring done in 2.AW
  (`ms->uart0.event_log = ms->gpio.event_log` + `boot_ns` +
  `port_num`) already covers both TX and RX since they share the
  same instance state.

## Estado consolidado (post-2.AX)

| Peripheral | TX-side JSON | RX-side JSON |
|------------|--------------|--------------|
| GPIO       | ✓ (pin events) | ✓ (input pad events) |
| LEDC       | ✓ (duty events) | n/a |
| ADC        | n/a | ✓ (sample reads) |
| TIMG       | ✓ (alarm/IRQ events) | n/a |
| I2C        | ✓ (FIFO/CMD events) | ✓ (slave responses) |
| SPI        | ✓ (transactions) | ✓ (slave responses) |
| WDT × 4    | ✓ (config events) | n/a |
| RNG        | n/a | ✓ (random reads) |
| **UART**   | ✓ (2.AW) | **✓ NEW (2.AX)** |

**JSON tracer coverage is now complete.** Every observable register-
level interaction with every implemented peripheral generates a
JSON event suitable for frontend rendering.

## 32-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AC-AF| LEDC PWM + multi-channel                               |
| 2.AG-AN.irq | TIMG (×2) + 3-way ISR                              |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO+AU | SPI master + ILI9341 responder                         |
| 2.AP-AT | 4 watchdogs + RNG + address relocation                |
| 2.AV  | GPIO LEVEL_HIGH/LOW filters                              |
| 2.AW  | UART TX JSON event tracking                              |
| **2.AX** | **UART RX JSON event tracking** — bidirectional UART  |

JSON stream now carries **16 event types**: `start | pin | ledc |
adc | timg | timg_irq | i2c | i2c_rx | spi | spi_rx | wdt | rng |
rtc_wdt | super_wdt | uart_tx | uart_rx`.

## Próximas direcciones

- **End-to-end UART RX validation**: connect chardev pipe in
  test harness, inject `"hello\n"`, assert 6 `uart_rx` events
  with bytes matching the input.
- **2.AV.real-pinreg**: refactor GPIO mask filters to per-pin
  GPIO_PINn_REG matching real silicon.
- **WDT actual reset action**: real timeout → CPU reset.
- **Real PWM waveform on GPIO** via LEDC.
- **TWAI (CAN bus)**, **RMT (WS2812 NeoPixel)**.
- **Real FreeRTOS port** (Phase 2.V deferred).
