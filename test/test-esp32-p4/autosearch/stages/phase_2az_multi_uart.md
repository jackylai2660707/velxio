# Phase 2.AZ — Multi-UART instantiation (UART1..UART4)

**Estado**: ✅ done — UART1, UART2, UART3, UART4 instantiated at
their real-silicon addresses. Each is a distinct `ESP32P4UARTState`
instance with its own `port_num`. Self-test on UART1 writes "U1"
(bytes 0x55, 0x31) via `address_space_write` so the JSON stream
shows two `{"event":"uart_tx","port":1,...}` records at boot —
proves that the **single QOM-class static `parent_write`/
`parent_read` pointer pattern from Phase 2.AW/2.AX scales cleanly
across multiple instances**.

This validates a non-obvious architectural claim and fills the
Arduino `Serial1`/`Serial2`/`Serial3` gap. Many embedded sketches
use Serial1 for GPS receivers, Bluetooth modules, or sensor
passthrough; Serial2 for RS-485 industrial buses. Without this,
those sketches would silently write into the void.

Log proof (2026-05-08):
```
uart_tx events by port:
   26 uart_tx","port":0     ← Phase 2.AW hello-world ("Hello from QEMU ESP32-P4!")
    2 uart_tx","port":1     ← Phase 2.AZ self-test ("U1")

Per-event detail:
{"t_ns":128500,"event":"uart_tx","port":1,"byte":85,"count":1}  → 'U'
{"t_ns":130898,"event":"uart_tx","port":1,"byte":49,"count":2}  → '1'
{"t_ns":62584867,"event":"uart_tx","port":0,"byte":72,"count":1} → 'H'
{"t_ns":62652126,"event":"uart_tx","port":0,"byte":101,"count":2} → 'e'
...
```

- `count` is per-instance: UART1's self-test gets `1, 2` while UART0's hello starts at `1, 2, ...26` independently.
- Timestamps make UART1 fire FIRST (at boot, before guest code runs) and UART0 fires LATER (when the demo blob calls into the inline UART writer ~62 ms in). Order confirms self-test happens during machine init.

## Goal

Phase 2.AW (UART TX JSON) and Phase 2.AX (UART RX JSON) established
the bidirectional tracking pipeline — but ONLY on UART0. The other
four HP UARTs (UART1..UART4) were create_unimplemented_device
stubs: any guest write to `0x500CB000+` (Serial1) just silently
absorbed the byte without emitting an event.

Two problems with this:

1. **Arduino `Serial1.print()` falls into a black hole**. Real
   Arduino sketches commonly use Serial1 for sensor passthrough
   (GPS, BT modules, RS-485 buses). The frontend has no way to
   render those.

2. **Phase 2.AW made an architectural claim that wasn't tested**:
   the comment in `esp32p4_uart.c` says the single static
   `esp32p4_uart_parent_write` works for all UART instances
   because the QOM class is shared. This claim was unverified —
   with only UART0 instantiated, multi-instance behavior was
   theoretical.

Phase 2.AZ fixes both: instantiate UART1..UART4, wire `event_log`
+ unique `port_num` for each, and add a self-test on UART1 that
PROVES port disambiguation works.

## Lo que SE INVESTIGÓ

### 1. QOM single-class-multiple-instances semantics

QEMU's QOM has one CLASS per `TypeInfo` and N INSTANCES per class.
`esp32p4_uart_class_init` runs ONCE (when the type is first
realized); it installs the static parent pointers and overrides:

```c
static void (*esp32p4_uart_parent_write)(...);
static uint64_t (*esp32p4_uart_parent_read)(...);

static void esp32p4_uart_class_init(ObjectClass *oc, void *data) {
    ESP32UARTClass *uart_class = ESP32_UART_CLASS(oc);
    esp32p4_uart_parent_write = uart_class->uart_write;
    uart_class->uart_write    = esp32p4_uart_write;
    esp32p4_uart_parent_read  = uart_class->uart_read;
    uart_class->uart_read     = esp32p4_uart_read;
}
```

Every instance of `TYPE_ESP32P4_UART` then dispatches through
`esp32p4_uart_write`. The wrapper casts `opaque` to the
INSTANCE-specific `ESP32P4UARTState *`, so each instance's
`event_log`, `boot_ns`, `port_num`, `tx_count`, and `rx_count`
fields are touched correctly.

The architectural claim from 2.AW: "Single global because all P4
UART instances share the same class hierarchy" is CORRECT. The
class-level pointer indirection is shared; the per-instance state
is per-instance. Verified live in this phase.

### 2. No-chardev instances

UART0 sets `qdev_prop_set_chr(... "chardev", serial_hd(0))` so
`Serial.print()` from UART0 goes to the host stdio via `-serial
stdio`. For UART1..UART4 we leave chardev unset:

```c
object_initialize_child(OBJECT(machine), "uart1", units[i],
                        TYPE_ESP32P4_UART);
/* No qdev_prop_set_chr — chardev stays NULL. */
sysbus_realize(SYS_BUS_DEVICE(units[i]), &error_fatal);
```

QEMU's chardev frontend (`CharBackend`) accepts NULL — calls to
`qemu_chr_fe_write_all` with no backend just discard the bytes.
Realize succeeds, MMIO writes work, JSON events fire — the bytes
just don't appear on the host terminal (which is correct: real
silicon would route these UARTs to physical pad pins via IO MUX,
not to a host file descriptor).

Future phase could optionally pipe UART1..4 to host files (e.g.,
`-chardev file,path=uart1.log,id=u1 -serial chardev:u1` style)
but that's not needed for the JSON-event use case.

### 3. Self-test via `address_space_write`

The native way to trigger a side-effect MMIO write from machine
init is `address_space_write(&address_space_memory, addr,
MEMTXATTRS_UNSPECIFIED, &val, size)`. This goes through the FULL
memory dispatch path — through the parent class's `uart_write`,
through our `esp32p4_uart_write` wrapper, emitting the JSON event.

Two writes of one byte each (`'U'`, `'1'`) into
`ESP32P4_UART1_BASE + 0` (the UART_FIFO offset) produce two
`{"event":"uart_tx","port":1,...}` records at boot. Validates the
path end-to-end without requiring guest firmware to exercise
UART1.

### 4. port_num assignment

UART0 = 0 (already wired in Phase 2.AW).
UART1 = 1, UART2 = 2, UART3 = 3, UART4 = 4 (per the
`ESP32P4_UARTn_BASE` enumeration). One-to-one mapping with the
silicon-level UART index. Frontend renders 5 separate Serial
monitors by switching on the `port` field.

## Lo que SÍ funcionó

Live test (2026-05-08):

```
uart_tx events by port:
  26 uart_tx","port":0
   2 uart_tx","port":1
```

26 port-0 events are the Phase 2.AW hello-world; the 2 port-1
events are this phase's self-test ("U1"). Both fire from the same
JSON tracer with the same code path, just different instance state.

Inter-instance count independence:

```
Port-1 events: count 1 → 2 (self-test "U1")
Port-0 events: count 1 → 26 (hello-world)
```

Each instance's `tx_count` field increments independently — no
cross-instance state pollution.

Build clean, no warnings. Regression-clean: every other peripheral
event count identical to Phase 2.AY within timing variance (RMT
self-test still fires its 3 pixels, TIMG IRQs still cadence at the
right rate, etc.).

## Lo que NO funcionó / decisiones tomadas

1. **No LP_UART instance yet**: ESP32-P4 has 6 UARTs total
   (UART0..4 on HP + 1 on LP). LP_UART at `0x50121000` is still
   covered by the unimplemented_device stub. Deferring because:
   - LP_UART is wired differently (LP-side power domain)
   - No common Arduino sketch uses it
   - Adding it requires more changes to power-management state
   
   Phase 2.AZ.lp can revisit.

2. **No `-chardev` plumbing for UART1..4**: writes to these UARTs
   currently go nowhere on the host side. Acceptable for the
   tracer use case (frontend reads JSON, not host stdio). A user
   wanting host I/O passthrough can add `-chardev file,...` flags
   in a follow-up.

3. **Self-test only on UART1**, not all four. Three reasons:
   - The JSON-tagging proof is the same regardless of which non-0
     UART self-tests.
   - Four self-tests would add 8 events at boot — noise.
   - If UART1 works, UART2..4 work (identical class, identical
     init).
   
   Documented as: if a regression ever appears on UART2..4, add a
   self-test for each as part of the regression catch.

4. **No JSON `uart_rx` self-test for non-0 UARTs**: same reasoning
   as 2.AX — RX requires external input (chardev pipe). Path is
   correct by construction (same wrapper code, just dispatched
   per-instance). Future end-to-end RX test would need to pipe
   bytes to a specific UART's chardev.

5. **Could have used a TypeInfo per UART instance**: not needed.
   QOM's instance-per-class model means we get isolation
   "for free" from the per-instance state struct. No reason to
   define `TYPE_ESP32P4_UART1`, etc.

## Lessons learned

1. **QOM class virtual + per-instance state IS the right pattern**:
   the architectural claim from 2.AW that "single static
   parent_write works for multiple instances" was correct but
   unverified. Phase 2.AZ proves it in production. Future
   peripherals with multiple instances (e.g., I2C0 + I2C1, TIMG0
   + TIMG1 with shared device class) follow this same pattern.

2. **Self-test via `address_space_write` is the cleanest hook**:
   no need to expose internal helpers from the device .c file;
   no need to call static functions from machine init; just write
   to the MMIO address and let normal dispatch fire the wrapper.
   Applies to any peripheral with a write side-effect.

3. **`port_num` field pays for itself in multi-instance contexts**:
   was added speculatively in Phase 2.AW with `port_num=0`
   hardcoded. Now that we have 5 instances it's the disambiguator
   the frontend needs. Lesson: when scaffolding a peripheral that
   COULD have multiple instances, add the per-instance identity
   field even if you only have one instance — it costs nothing
   and saves a refactor later.

4. **Empty regex matches can mean "wrong escape"**: at one point
   `grep -E '"event":"uart_tx".*"port":1,'` returned empty in a
   PowerShell→WSL→bash chain, even though the underlying data
   matched. Lesson: when a multi-shell quoted regex returns
   empty, simplify the pattern to verify the data is correct
   before chasing a "bug".

## Implementación final

### `hw/riscv/esp32p4.c`

- ESP32P4State gains `uart1`, `uart2`, `uart3`, `uart4` fields of
  type `ESP32P4UARTState`.
- New init block after UART0:
  - Loop over 4 instances + their bases (`ESP32P4_UART1..4_BASE`).
  - `object_initialize_child` → `sysbus_realize` → MMIO overlay at
    priority 1.
  - No chardev wiring (different from UART0).
- New event_log wiring block after the UART0 wiring:
  - For each instance, set `event_log`, `boot_ns`, `port_num`
    (1..4).
  - Self-test: write "U1" to UART1 via `address_space_write`.

### No header / class changes

The existing `TYPE_ESP32P4_UART` class definition from 2.AW/2.AX
covers all 5 instances. No code added to `esp32p4_uart.c` or
`esp32p4_uart.h` this phase.

## Estado consolidado (post-2.AZ)

UART inventory:

| Port  | Base       | Phase | chardev | port_num | Use case |
|-------|------------|-------|---------|----------|----------|
| UART0 | 0x500CA000 | 1.A   | stdio   | 0        | Arduino Serial |
| UART1 | 0x500CB000 | 2.AZ  | none    | 1        | Arduino Serial1 (GPS, BT) |
| UART2 | 0x500CC000 | 2.AZ  | none    | 2        | Arduino Serial2 (RS-485) |
| UART3 | 0x500CD000 | 2.AZ  | none    | 3        | available |
| UART4 | 0x500CE000 | 2.AZ  | none    | 4        | available |
| LP_UART | 0x50121000 | unimp | n/a   | n/a      | LP-side (future) |

JSON event types: 17 (unchanged — Phase 2.AZ adds instances, not
new event types).

## 34-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AC-AF| LEDC PWM + multi-channel                               |
| 2.AG-AN.irq | TIMG (×2) + 3-way ISR                              |
| 2.AM-slave | I2C master + BMP280 responder                      |
| 2.AO+AU | SPI master + ILI9341 responder                         |
| 2.AP-AT | 4 watchdogs + RNG + address relocation                |
| 2.AV  | GPIO LEVEL_HIGH/LOW filters                              |
| 2.AW-AX | UART0 bidirectional JSON tracking                      |
| 2.AY  | RMT (WS2812 NeoPixel) skeleton                           |
| **2.AZ** | **Multi-UART (UART1..UART4) with per-port JSON tags** |

## Próximas direcciones

- **2.AZ.lp**: instantiate LP_UART at 0x50121000 (port_num = 5).
- **2.AZ.chardev**: optional `-chardev` plumbing for UART1..4 so
  host can passthrough Serial1/2 traffic if desired.
- **TWAI (CAN bus)** — TRM Chapter 30. Next big new peripheral.
- **WDT actual reset action** — close out watchdog chain.
- **I2C1 instantiation** — mirror of UART1..4 pattern for I2C.
- **Real PWM waveform on GPIO** via LEDC.
- **FreeRTOS real port** (Phase 2.V deferred).
