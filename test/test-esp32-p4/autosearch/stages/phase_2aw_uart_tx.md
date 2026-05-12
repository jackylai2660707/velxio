# Phase 2.AW — UART TX JSON event tracking

**Estado**: ✅ done — every byte the chip transmits via UART0 now
appears in the JSON event stream as `{"event":"uart_tx",...}`.
Frontend can render `Serial.print()` output verbatim. Self-validates
via Phase 2.N's hello-world: 26 events decoded as ASCII spell
"Hello from QEMU ESP32-P4!\n".

This closes a major gap — UART was the ONE peripheral with stderr
visibility but NO JSON visibility, so the frontend couldn't render
Arduino Serial output alongside GPIO/LEDC/ADC/etc.

## Goal

Every other peripheral emits JSON events for observable state
changes:
- GPIO → pin transitions
- LEDC → duty writes
- ADC → samples
- TIMG/TIMG1 → counter + alarm + IRQ
- I2C → bytes + commands + slave responses
- SPI → transactions + slave responses
- WDT/RTC_WDT/SUPER_WDT → unlock/feed/lock
- RNG → values

UART was the conspicuous gap. Stderr showed the bytes via parent
class's `[esp32_uart]` logs, but the structured JSON tracer didn't
see them.

Phase 2.AW adds JSON event emission for every TX byte. Frontend can
now show a "Serial monitor" view alongside the bus tracers.

## Lo que SE INVESTIGÓ

### 1. QOM class virtual method override pattern

The ESP32 UART parent class uses a virtual `uart_write` function
pointer on the class struct (`include/hw/char/esp32_uart.h`):

```c
typedef struct ESPUARTClass {
    SysBusDeviceClass parent_class;
    void (*uart_write)(void *opaque, hwaddr addr, uint64_t value, ...);
    uint64_t (*uart_read)(void *opaque, hwaddr addr, unsigned int size);
} ESP32UARTClass;
```

The instance_init function reads `class->uart_write` to populate the
MemoryRegionOps that QEMU dispatches to. Override semantics:

1. Parent class_init sets `class->uart_write = esp32_uart_write`
2. Child class_init (ESP32P4_UART) runs AFTER parent — sees the
   parent's value
3. Child can save the pointer into a static and replace with its own
4. Child's wrapper calls the saved parent pointer then adds logic

```c
static void (*esp32p4_uart_parent_write)(...);
static void esp32p4_uart_write(...) {
    esp32p4_uart_parent_write(opaque, addr, value, size);
    /* additional logic: emit JSON */
}
static void esp32p4_uart_class_init(...) {
    ESP32UARTClass *uart_class = ESP32_UART_CLASS(oc);
    esp32p4_uart_parent_write = uart_class->uart_write;
    uart_class->uart_write = esp32p4_uart_write;
}
```

Single static variable works for all P4 UART instances because the
class is shared (QOM has one class per type, multiple instances).

### 2. Where the FIFO write happens

The UART TX FIFO is at offset 0 (`A_UART_FIFO`, defined in
`include/hw/char/esp32_uart.h`). Guest writes 1 byte to address
`UART_BASE + 0` to push a TX byte. The parent class handles:
- Push byte to internal FIFO
- Forward to chardev via `qemu_chr_fe_write` (for `-serial stdio`)
- Update interrupt status

Our wrapper detects `addr == A_UART_FIFO`, extracts the low byte,
and emits a JSON event. We chain to the parent for the actual TX
side-effects.

### 3. No throttling

For peripherals like ADC and I2C the JSON event throttle (50 ms)
prevents flooding from tight register-poll loops. UART is different:
each TX byte is a discrete, meaningful event — losing bytes would
corrupt the rendered output.

`Serial.print("Hello from QEMU ESP32-P4!")` writes 26 bytes back-to-
back over ~100 µs. Without throttling we get 26 events. With 50 ms
throttle we'd get 1. So we keep this peripheral un-throttled.

### 4. Wiring event_log AFTER GPIO realize

Other peripherals copy `event_log` from `ms->gpio.event_log` in
their own init block, but they're all realized AFTER GPIO. UART0 is
realized BEFORE GPIO — at UART init time, `ms->gpio.event_log`
isn't valid yet.

Fix: add a post-GPIO-realize wiring step:
```c
ms->uart0.event_log = ms->gpio.event_log;
ms->uart0.boot_ns   = ms->gpio.boot_ns;
ms->uart0.port_num  = 0;
```

This pattern works because the JSON emit logic checks `if
(s->event_log)` at runtime — when the early UART TX happens before
the wiring is done, it's silent; after wiring, JSON events appear.

## Lo que SÍ funcionó

10-second live test (2026-05-12):

```
=== JSON event totals ===
Total lines: 484  (was 452 in Phase 2.AV; +32 = +26 uart_tx + ±timing)

  "event":"uart_tx":  26   ← NEW: Hello-from-QEMU bytes
  ... other counts unchanged within timing variance ...
```

First 10 uart_tx events decoded as ASCII:

```json
{"t_ns":65619051,"event":"uart_tx","port":0,"byte": 72,"count": 1}  → 'H'
{"t_ns":65677940,"event":"uart_tx","port":0,"byte":101,"count": 2}  → 'e'
{"t_ns":65680694,"event":"uart_tx","port":0,"byte":108,"count": 3}  → 'l'
{"t_ns":65683126,"event":"uart_tx","port":0,"byte":108,"count": 4}  → 'l'
{"t_ns":65687307,"event":"uart_tx","port":0,"byte":111,"count": 5}  → 'o'
{"t_ns":65690224,"event":"uart_tx","port":0,"byte": 32,"count": 6}  → ' '
{"t_ns":65692191,"event":"uart_tx","port":0,"byte":102,"count": 7}  → 'f'
{"t_ns":65694190,"event":"uart_tx","port":0,"byte":114,"count": 8}  → 'r'
{"t_ns":65707305,"event":"uart_tx","port":0,"byte":111,"count": 9}  → 'o'
{"t_ns":65710598,"event":"uart_tx","port":0,"byte":109,"count":10}  → 'm'
```

Concatenating all 26 bytes spells **"Hello from QEMU ESP32-P4!\n"**
— the canonical Phase 2.N hello-world message, now visible in JSON.

Inter-byte timing: ~2-3 µs apart at TCG speed. UART TX timing in
the demo blob is loop-bound (writes 26 bytes in tight succession
through the inline UART writer at 0x40400138 area).

No regression: every other event count identical to Phase 2.AV
within timing variance.

## Lo que NO funcionó / decisiones tomadas

1. **No UART RX JSON event yet**: this phase covers TX only.
   Adding RX would require either:
   - Overriding the parent's `uart_read` similarly (FIFO read → emit
     event with the byte being delivered)
   - OR injecting a chardev backend handler that intercepts inbound
     bytes
   Both possible, neither done this phase. Documented as Phase
   2.AW.rx.

2. **Single static `parent_write` works for multiple instances**:
   even when we eventually instantiate UART1..UART4, all share the
   same class so the static `parent_write` pointer is correct for
   all. Documented because it's an easy "I should make this per-
   instance" mistake to make.

3. **Port number hardcoded to 0**: we only have one UART instance.
   When UART1..UART4 are added (future phase), each needs its own
   `port_num` assigned in machine init. Architecture supports it
   via the per-instance `port_num` field.

4. **Wiring step after GPIO realize is ugly**: peripheral init
   order matters for getting `event_log`. A cleaner refactor would
   be to centralize the event_log into a machine-level field that
   all peripherals reach via a property/pointer, instead of
   copying via `ms->gpio.event_log`. Documented as a future
   cleanup.

## Lessons learned

1. **QOM class virtual methods are the right hook for subclass
   instrumentation**: rather than copying the entire parent's
   write function, override the class virtual and chain. The
   "save parent → replace → wrapper calls saved" pattern keeps the
   subclass code small and forward-compatible with parent updates.

2. **UART output deserves to be in the JSON stream**: every other
   peripheral has been emitting JSON since Phase 2.X, UART was the
   outlier. Frontend renders that decided to show a "serial
   monitor" view couldn't until now.

3. **Hello-world is a great validation signal**: 26 bytes decoded
   as ASCII spelling "Hello from QEMU ESP32-P4!" is unambiguous —
   the test EITHER produces it correctly OR not. No edge cases.

4. **Init order matters for event_log wiring**: any peripheral
   realized before GPIO needs a post-GPIO-realize wiring step (or
   a smarter init pattern). Documented for future peripherals.

## Implementación final

### `include/hw/char/esp32p4_uart.h`

- ESP32P4UARTState gains: `event_log`, `boot_ns`, `tx_count`,
  `port_num` fields.

### `hw/char/esp32p4_uart.c`

- New static `esp32p4_uart_parent_write` saves the parent's virtual.
- New `esp32p4_uart_write()` wrapper: chain to parent, then emit
  JSON for TX FIFO writes (offset 0).
- New `esp32p4_uart_class_init()` saves parent's write and overrides
  with the wrapper.
- `TypeInfo` gains `.class_init = esp32p4_uart_class_init`.

### `hw/riscv/esp32p4.c`

- Post-GPIO-realize block sets `ms->uart0.event_log = ms->gpio.event_log`,
  `boot_ns`, `port_num = 0`.

## Estado consolidado (post-2.AW)

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
| **UART**   | **✓ NEW (2.AW)**  | ⏳ (Phase 2.AW.rx) |

JSON tracer coverage is now near-complete — UART RX is the only
remaining gap.

## 31-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AC-AF| LEDC PWM + multi-channel                               |
| 2.AG-AN.irq | TIMG (×2) + 3-way ISR                              |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO+AU | SPI master + ILI9341 responder                         |
| 2.AP-AT | 4 watchdogs + RNG + address relocation                |
| 2.AV  | GPIO LEVEL_HIGH/LOW filters                              |
| **2.AW** | **UART TX JSON event tracking**                       |

JSON stream now carries **15 event types**: `start | pin | ledc |
adc | timg | timg_irq | i2c | i2c_rx | spi | spi_rx | wdt | rng |
rtc_wdt | super_wdt | uart_tx`.

## Próximas direcciones

- **Phase 2.AW.rx**: UART RX JSON event tracking. Override
  `uart_read` similarly to detect FIFO reads.
- **2.AV.real-pinreg**: refactor GPIO mask filters to per-pin
  GPIO_PINn_REG matching real silicon.
- **WDT actual reset action**: real timeout → CPU reset.
- **Real PWM waveform on GPIO** via LEDC.
- **TWAI (CAN bus)**, **RMT (WS2812 NeoPixel)**.
- **Real FreeRTOS port** (Phase 2.V deferred).
