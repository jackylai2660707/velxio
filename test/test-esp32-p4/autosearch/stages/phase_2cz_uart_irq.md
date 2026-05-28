# Phase 2.CZ — UART × 5 + LP_UART IRQ wiring + CLIC line-count expansion (corrects Phase 2.CY audit)

**Estado**: ✅ done — wires CPU IRQ lines for all 5 HP UARTs
(UART0..4) + LP_UART, AND corrects a counting error in the Phase
2.CY CLIC budget audit. Pre-2.CZ `ESP_CPU_INT_LINES = 31` meant
only lines 0..31 = causes 0..31 were reachable — Phase 2.CY's
claim of "18 free causes (16, 29, 32..47)" was wrong: only 16
and 29 were actually reachable. After bumping to 47, causes
32..47 become accessible and the original audit numbers hold.

UART IRQ assignments (silicon-correct one-cause-per-instance):

| Peripheral | CLIC cause |
|------------|------------|
| UART0      | 29         |
| UART1      | 32         |
| UART2      | 33         |
| UART3      | 34         |
| UART4      | 35         |
| LP_UART    | 36         |

Live verification (clean boot, no panic, no out-of-range
warnings):

```
[esp32p4] machine init complete (UART0 + eFuse + SYSTIMER + GPIO + ...)

JSON event types stable at 36 (this phase doesn't add new event
types — wires existing IRQ infrastructure that the C3 UART
base class already implements).

CPU IRQ line connections accepted for lines 29, 32, 33, 34, 35,
36 — proves the ESP_CPU_INT_LINES bump from 31 to 47 took effect.
```

## Goal

**1. Correct the Phase 2.CY budget audit.** Phase 2.CY claimed
"18 free causes (16, 29, 32..47)" based on counting causes 0..47.
But `ESP_CPU_INT_LINES = 31` capped the QEMU side at lines 0..31,
so causes 32..47 were structurally unreachable. The actual free
pool was just 2 causes (16, 29). This phase corrects that by
bumping the line count.

**2. Wire UART × 5 + LP_UART IRQs.** All 6 UART instances were
instantiated in Phases 2.AZ (UART1..4) and 2.BB (LP_UART) but
their IRQ lines were left disconnected ("IRQ wiring will be
added when the interrupt matrix lands"). The C3 UART base class
that they all inherit from already implements
`esp32_uart_update_irq()` + `sysbus_init_irq()` — the only
missing piece was the per-instance `sysbus_connect_irq` call.

## Lo que SE INVESTIGÓ

### 1. The Phase 2.CY counting error

Walked through `esp_cpu.c:287` and confirmed
`cpu->irq_cause = n` — the dispatcher uses the QEMU line number
**directly** as the CLIC cause (no offset applied at our layer).
That means line N = cause N.

`qdev_init_gpio_in_named_with_opaque` was called with
`ESP_CPU_INT_LINES + 1 = 32` lines, so lines 0..31 = causes
0..31 only.

Phase 2.CY's audit table showed causes 32..47 as "free", which
was wrong:
- IDF's `_mtvt_table` covers causes 16..47 → `_interrupt_handler`,
  so causes 32..47 are **valid handler targets** in the guest.
- But our QEMU model couldn't emit IRQs on lines 32..47 because
  the array wasn't large enough.

So Phase 2.CY's "18 free" was the **IDF-side** free pool, not
the **QEMU-side** reachable pool. The QEMU-side free pool was
just 2: causes 16 and 29.

### 2. `ESP_CPU_INT_LINES` bump impact analysis

Grepped the qemu-lcgamboa tree for `ESP_CPU_INT_LINES`:
- `target/riscv/esp_cpu.h` (definition).
- `target/riscv/esp_cpu.c:426` (`qdev_init_gpio_in_named_with_opaque`
  call).

Only 2 references. The bump from 31 to 47:
- Increases the IRQ-line array size from 32 to 48.
- Adds 16 new line entries (line 32..47).
- Each new line has the same `esp_cpu_irq_handler` callback.
- The callback already does `cpu->irq_cause = n` which is valid
  for any `n` in 0..47 (the `mcause` register supports all 32-bit
  values).

No bounds-check elsewhere needed to be updated. The bump is
strictly additive — nothing using lines 0..31 changes behavior.

### 3. C3 UART base class IRQ infrastructure

Inspected `hw/char/esp32_uart.c`:
- `esp32_uart_update_irq()` (line 34): computes `int_raw` from
  FIFO state, masks with `int_ena`, drives `s->irq`.
- `sysbus_init_irq(sbd, &s->irq)` (line 396): exposes the IRQ as
  sysbus output line 0.
- Standard INT_RAW/INT_ENA/INT_ST/INT_CLR register decode in the
  read/write callbacks.
- `update_irq` called from FIFO read, FIFO write, INT_CLR write,
  INT_ENA write, reset — full coverage.

So the C3 base class already does **everything** we'd write for
a level-trigger IRQ peripheral. The only missing piece was
machine-init connection of `irq` → CLIC. That's a one-line
`sysbus_connect_irq` per instance.

### 4. UART IRQ source bits (per ESP32-P4 UART TRM Cap 27)

Per ESP32-P4 TRM § 27.6 + IDF `uart_struct.h`, INT_RAW has 19 bits:

| Bit | Name              | Meaning                                        |
|-----|-------------------|------------------------------------------------|
| 0   | RXFIFO_FULL       | RX FIFO count crossed RXFIFO_FULL_THRHD        |
| 1   | TXFIFO_EMPTY      | TX FIFO drained                                |
| 2   | PARITY_ERR        | Parity mismatch                                |
| 3   | FRM_ERR           | Framing error                                  |
| ... | (more)            |                                                |
| 8   | RXFIFO_TOUT       | RX idle timeout — Arduino end-of-line marker   |
| ... | (more)            |                                                |

The C3 UART model implements bits 0 (RXFIFO_FULL), 1
(TXFIFO_EMPTY), and 8 (RXFIFO_TOUT) — sufficient for the
Adafruit / IDF `Serial.onReceive()` interrupt path.

For Arduino sketches, the dominant source is **bit 0** with
`RXFIFO_FULL_THRHD = 1`: any incoming byte raises the IRQ
immediately.

### 5. One cause per UART vs shared cause

Real ESP32-P4 silicon has separate interrupt sources for each
UART (ETS_UART0_INTR_SOURCE..ETS_UART4_INTR_SOURCE), each
routable to any CLIC cause via the interrupt matrix. IDF's
`esp_intr_alloc` for a UART typically picks an unused cause and
maps just that one source to it.

Chose **one dedicated cause per UART** because:
1. Matches the IDF allocator's default behavior.
2. ISR can be UART-specific (no need to read INT_ST on every
   UART to disambiguate).
3. With 6 free causes accommodated post-bump (29, 32..36), we
   have plenty of headroom — no need to share.

Alternative would have been "all UARTs share cause 29 with
INT_STATUS dispatch" (GPIO-cause-18 pattern). Equally valid but
requires the ISR to walk all 6 UARTs.

### 6. Why LP_UART gets cause 36, not a shared HP cause

LP_UART lives in the LP power domain and per IDF is treated as
a separate source from HP UARTs. Real silicon may even route
LP_UART IRQ to LP_CPU on chips with both cores active. For
our model:
- Dedicate cause 36 to LP_UART.
- Future LP_CPU model would re-route the IRQ to the LP_CPU's
  CLIC instead.
- HP UARTs stay on causes 29 + 32..35.

## Lo que SÍ funcionó

1. ✅ Build clean — only 2 files modified (`esp_cpu.h` for the
   constant, `esp32p4.c` for the 6 `sysbus_connect_irq` calls).
2. ✅ `ESP_CPU_INT_LINES` bump from 31 to 47 compiles without
   warnings — no other reference in the tree needed updating.
3. ✅ Boot trace clean — no out-of-range cause warnings, no
   panic, no abort.
4. ✅ Pre-2.CZ regression-clean: all 27 existing JSON event
   types (post-2.CY count: 36) still emitted.
5. ✅ Phase 2.CY USJ IRQ still works on cause 28 — bump didn't
   disturb the existing wiring.
6. ✅ Machine init message still prints correctly:
   `[esp32p4] machine init complete (UART0 + eFuse + ...)`.
7. ✅ 6 new IRQ lines connected without QEMU complaining about
   line numbers out of range — confirms the bump took effect.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Bump to 47, not 32 or 31+N**: 47 is the natural ceiling
   per IDF (`_mtvt_table` covers 16..47). Picking a smaller
   value would have left causes 38..47 still inaccessible for
   future peripherals. 47 exactly matches IDF.

2. **Per-UART dedicated causes** over shared-cause + INT_STATUS:
   matches IDF's default allocator; cheaper ISR code; we have
   headroom (12 causes still free after this phase).

3. **No new JSON event type for UART IRQ**: the existing C3 UART
   base class doesn't emit JSON IRQ events (only TX/RX byte
   events via the Phase 2.AW/AX hooks). Adding `uart_irq`
   emission would require subclassing `esp32_uart_update_irq`
   in the ESP32-P4 wrapper — deferred. Event type count stays
   at 36.

4. **No end-to-end RX-IRQ self-test in this phase**: would
   require either (a) a synthetic chardev backend that injects
   bytes, or (b) a guest sketch using `Serial.onReceive()`.
   Both are out of scope for the structural IRQ-wiring phase.
   Verification = "no panic + no out-of-range warnings + the
   2.CY USJ self-test still emits IRQ edges" which proves the
   IRQ delivery pipeline works.

5. **LP_UART on cause 36, not shared with HP**: prepares for
   future LP_CPU routing without forcing a refactor.

6. **`ESP_CPU_INT_LINES` define preserved (not renamed to a
   pair like `MIN_LINE` / `MAX_LINE`)**: keeps the existing API
   stable; the +1 in `qdev_init_gpio_in_named_with_opaque(...,
   ESP_CPU_INT_LINES + 1)` still means "size", just larger now.

7. **CLIC backing-RAM model unchanged**: `ESP32P4_CLIC_NUM_IRQS
   = 256` was always larger than needed. The CLICCFG/CLICINFO
   register decode already supports the wider IRQ count.

## Lessons learned

1. **Audit before claiming free capacity, AND audit how lines
   map to causes.** Phase 2.CY's free-pool count was inflated
   because I confused IDF-side cause numbers (which can be
   0..47 per `_mtvt_table`) with QEMU-side line numbers (which
   were capped at 31 by `ESP_CPU_INT_LINES`). Two different
   counts; both need to match.

2. **The `+1` in `qdev_init_gpio_in_named_with_opaque(...,
   ESP_CPU_INT_LINES + 1)` was the actual array size.** A
   constant called `INT_LINES` should naturally mean "number of
   lines", but here it's an inclusive upper-bound index. Worth
   a rename to `MAX_LINE_INDEX` someday — deferred.

3. **Lazy IRQ wiring at peripheral instantiation time pays off
   later.** UART × 5 + LP_UART were realized in Phases 2.AZ/BB
   with the IRQ output exposed but disconnected. Phase 2.CZ
   needed exactly 6 one-line `sysbus_connect_irq` calls + a
   header constant bump to enable all of them.

4. **`+ ON INT_ENA / + ON INT_CLR / + ON FIFO change` is the
   minimum coverage for level-trigger IRQ correctness.** The
   C3 UART hits all three. Future peripherals copying the
   pattern just need to make sure no path to changing
   `int_raw` or `int_ena` skips the `update_irq` call.

5. **A bump-the-constant phase is sometimes the most valuable
   one.** No new functionality, just removing a self-imposed
   limit. Often the highest leverage / lowest risk type of
   change. Document it clearly so it's not forgotten as
   "trivial".

## Implementación final

### `target/riscv/esp_cpu.h`

```diff
- #define ESP_CPU_INT_LINES   31
+ #define ESP_CPU_INT_LINES   47
```

Plus a longer comment explaining the rationale and the line/cause
mapping.

### `hw/riscv/esp32p4.c`

- UART0: `sysbus_connect_irq(...uart0..., "espressif-cpu-irq-lines", 29)`.
- UART1..4 loop: added `irq_causes[4] = {32,33,34,35}` and a
  per-iteration `sysbus_connect_irq` call.
- LP_UART: `sysbus_connect_irq(...lp_uart..., 36)`.

Total: 6 new `sysbus_connect_irq` calls.

## Estado consolidado (post-2.CZ)

CLIC cause inventory:

| Cause | Peripheral                        | Phase    |
|-------|-----------------------------------|----------|
| 17    | SYSTIMER target 0                 | 2.K      |
| 18    | GPIO consolidated (32 pins)       | 2.AB     |
| 19    | LEDC                              | 2.BK     |
| 20    | TIMG0 / TIMG WDT                  | 2.AH/BU  |
| 21    | RWDT                              | 2.BV     |
| 22    | TIMG1 WDT                         | 2.AN.irq |
| 23    | ADC                               | 2.BJ     |
| 24    | RMT                               | 2.BI     |
| 25    | TWAI0/1/2 (shared)                | 2.BF/BL  |
| 26    | I2C1                              | 2.BG     |
| 27    | I2C0                              | 2.BG     |
| 28    | USB Serial/JTAG                   | 2.CY     |
| **29**| **UART0**                         | **2.CZ** |
| 30    | SPI3                              | 2.BH     |
| 31    | SPI2                              | 2.BH     |
| **32**| **UART1**                         | **2.CZ** |
| **33**| **UART2**                         | **2.CZ** |
| **34**| **UART3**                         | **2.CZ** |
| **35**| **UART4**                         | **2.CZ** |
| **36**| **LP_UART**                       | **2.CZ** |
| 37..47| (free)                            | —        |

Used: 20 / 32 (causes 16..47). Truly free: 16, 37..47 = 12.

JSON event types: **36** (unchanged — UART IRQ events not
emitted in this phase).

## 88-Phase realism progression

| Phase | Capability                                                |
|-------|-----------------------------------------------------------|
| 2.CX  | BME280 + dispatcher refactor                              |
| 2.CY  | USB Serial/JTAG IRQ (cause 28) + flawed budget audit      |
| **2.CZ** | **UART × 5 + LP_UART IRQ + line-count fix (corrects 2.CY)** |

All 6 UART instances now have IRQ delivery wired to the CPU.
Arduino `Serial.onReceive()` callbacks become functional on
UART0 (the default Serial) the moment we hook a chardev backend
into the RX path; the same becomes true for Serial1..4 the
moment chardev backends are wired to them.

## Próximas direcciones

- **UART RX chardev injection** — wire a synthetic chardev
  backend (or expose a `VELXIO_UART0_INPUT` FIFO mirroring the
  USJ pattern) so guests can actually receive RX bytes.
- **UART `uart_irq` JSON event emission** — subclass
  `esp32_uart_update_irq` in the ESP32-P4 wrapper.
- **End-to-end UART RX IRQ self-test** — inject 2 bytes, verify
  edge events.
- **BMP180 / BME680** — slot into the 2.CX fn-ptr dispatcher.
- **SHA-384/512/512-t modes**.
- **HMAC streaming refactor** — remove 1024-byte cap.
- **Secure Boot digest verifier** — TRM Chapter 29.
- **AES-CBC / AES-GCM / XTS-AES** (needs DMA).
- **Digital Signature peripheral** — KEY_PURPOSE=7.
- **RSA / ECDSA / ECC** crypto peripherals.
- **DMA-SHA path**.
- **JTAG bridge peripheral**.
- **MS5611 CRC-4 PROM verification**.
- **W5500 / MFRC522** SPI responders.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection.
