# Phase 2.U (re-scoped) — Hand-rolled LED blink demo

**Estado**: ✅ done — Hello world + visible GPIO pin-5 toggle loop, no
FreeRTOS / no Arduino runtime / no Print.

## Goal

Reach a "minimum viable Arduino emulation" milestone: visible LED
blink output without depending on the IDF runtime, FreeRTOS scheduler,
C++ static constructors, or partition-table parsing.

The Phase 2.T-fix.next.next analysis showed that chasing single null-
deref panics into FreeRTOS state init was unbounded work. Instead,
**isolate the LED-blink subset** by replacing the busy loop tail of
the hello-world bypass with a hand-rolled GPIO toggle loop.

## Lo que SE INVESTIGÓ

### 1. ESP32-P4 GPIO model state

Read `hw/gpio/esp32p4_gpio.c`. Existing model:
- `R_GPIO_OUT      = 0x04` (read/write all output pins)
- `R_GPIO_OUT_W1TS = 0x08` (write-1-to-set bits)
- `R_GPIO_OUT_W1TC = 0x0C` (write-1-to-clear bits)
- `esp32p4_gpio_update()` logs every pin transition via
  `qemu_log_mask(LOG_GUEST_ERROR, ...)` and pulses `s->pin_irq[pin]`.

**Visibility issue**: `LOG_GUEST_ERROR` is silent unless the user runs
QEMU with `-d guest_errors`. The default demo run script does NOT
pass that flag. Patched the GPIO model to use `fprintf(stderr, ...)`
for unconditional visibility.

### 2. RISC-V instruction encoding for the blink loop

Encoded by hand (no riscv32 toolchain in our build env):

| Instruction                  | Hex          | Notes                       |
|------------------------------|--------------|-----------------------------|
| `lui  t2, 0x500E0`           | `0x500E03B7` | t2 = GPIO base 0x500E0000   |
| `addi t3, x0, 0x20`          | `0x02000E13` | t3 = pin-5 mask (1<<5)      |
| `sw   t3, 8(t2)`             | `0x01C3A423` | W1TS (turn pin 5 ON)        |
| `lui  t5, 0x1000`            | `0x01000F37` | t5 = 0x1000000 (16M counter)|
| `addi t5, t5, -1`            | `0xFFFF0F13` | dec counter                 |
| `bnez t5, -4`                | `0xFE0F1EE3` | spin until 0                |
| `sw   t3, 12(t2)`            | `0x01C3A623` | W1TC (turn pin 5 OFF)       |
| `j -32` (`jal x0, -32`)      | `0xFE1FF06F` | back to W1TS                |

Layout from 0x4000305A (the .done branch target after the hello
loop's null-terminator), 11 instructions, 44 bytes:

```
0x4000305A: lui  t2, 0x500E0
0x4000305E: addi t3, x0, 0x20
0x40003062: .loop:
            sw   t3, 8(t2)         ; W1TS pin 5 ON
0x40003066: lui  t5, 0x1000        ; counter = 16M
0x4000306A: addi t5, t5, -1
0x4000306E: bnez t5, -4
0x40003072: sw   t3, 12(t2)        ; W1TC pin 5 OFF
0x40003076: lui  t5, 0x1000        ; reload counter
0x4000307A: addi t5, t5, -1
0x4000307E: bnez t5, -4
0x40003082: j    .loop (-32)
```

The blink overlaps bytes `0x4000307C..0x4000307F` of the now-fixed
Phase 2.M `j setup()` patch (`0xFA5FC06F`). The patch ordering puts
Phase 2.U later, so Phase 2.U wins. Phase 2.M is dormant under the
hello-world bypass anyway, so the overwrite is benign.

### 3. Counter sizing

First attempt with `addi t5, x0, 0x7FF` (counter = 2047 iterations)
produced **2,355,467 toggles in 10 seconds** — too fast to read.
Replaced with `lui t5, 0x1000` (counter = 16M iterations) → **799
toggles in 10 seconds = ~80 Hz**. Visible blink rhythm.

## Lo que SÍ funcionó

Default build output:

```
[esp32p4] machine init complete ...
Hello from QEMU ESP32-P4!
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
... (alternating, ~80 transitions/sec)
```

This is the **first user-visible sustained operation** of the emulator
beyond the one-shot hello-world print. Two peripherals running
concurrently:
- UART0 (the hello string).
- GPIO Matrix (pin-5 toggles, with `pin_irq[5]` pulsing).

81 runtime patches active (was 75 before Phase 2.U).

## Lo que NO funcionó (intentado)

1. **Counter = 0x7FF (2047)**: too fast, 235k toggles/sec floods the
   terminal. Replaced with `lui t5, 0x1000` (16M).

2. **Considered using `qemu_log_mask(LOG_GUEST_ERROR, ...)`**: reads
   the existing comment "/* visible without -d unimp */" suggested it
   was always visible, but empirically the run script doesn't pass
   `-d guest_errors` so log_mask was silent. Switched to plain
   `fprintf(stderr)` — no flag dependency.

3. **Re-considered keeping Phase 2.O CSR enables alongside the blink
   demo**: would have needed 11 (blink) + 4 (CSR) = 15 instructions =
   60 bytes, exceeding the 0x4000305A..0x40003086 region available
   without overflowing into other functions. Dropped CSR enables for
   the blink demo since interrupts aren't needed for the GPIO toggle.
   The CLIC dispatch (Phase 2.S) and SYSTIMER tick still work in
   builds that re-enable Phase 2.O.

## Lessons learned

1. **Hand-rolled MMIO blob is the smallest viable Arduino emulation
   path**. Skipping FreeRTOS/IDF entirely and writing direct MMIO
   loops in the runtime-patch system means we can demonstrate
   peripherals working without solving the full runtime puzzle.

2. **Tight encoding is doable**: 11 RV32I instructions = 44 bytes
   is enough for full setup + dual delay + toggle loop. The 21-bit
   JAL imm can encode loops up to ±1 MB.

3. **Counter sizing matters**: at QEMU's TCG speed, 1M-iteration
   busy waits are ~milliseconds. Sub-1k iterations are imperceptibly
   fast and flood the log. ~16M was a sweet spot for an ~80 Hz
   visible blink.

4. **GPIO model already had everything**: pin transitions, IRQ
   pulse, level tracking — only the visibility (log mask) was
   missing.

5. **Patch ordering matters when overlapping**: when two runtime
   patches write to overlapping byte ranges, the LATER one wins.
   Useful here (Phase 2.U overwrites Phase 2.M's bytes), but a
   landmine if accidental.

## Archivos tocados

- `hw/gpio/esp32p4_gpio.c`: replaced `qemu_log_mask(LOG_GUEST_ERROR, …)`
  with `fprintf(stderr, …)` so pin transitions are visible by default.
- `hw/riscv/esp32p4.c`: replaced 6 Phase 2.O CSR-enable patches with
  11 Phase 2.U LED-blink patches (kept the `beqz` offset patch since
  the .done branch target shifted to align with the blink head).

## Estado consolidado (post-2.U)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| Hello-world demo (default build)                        | ✅           |
| **GPIO pin-5 LED-blink visible (~80 Hz)**               | ✅ Phase 2.U |
| **Two peripherals running concurrently (UART + GPIO)**  | ✅ Phase 2.U |
| Bypass-dropped: real setup() / loop() runs              | ❌ requires FreeRTOS port emulation |
| Multi-pin GPIO interaction                              | ⏳ Phase 2.W |
| Add input-pin handling (push-button → IRQ)              | ⏳ Phase 2.W |

## Next phases

- **Phase 2.V** (parallel track): real FreeRTOS port emulation —
  long, multi-week. Unblocks setup() / loop() for the natural
  Arduino flow.
- **Phase 2.W**: extend the LED-blink demo with input pins, wire up
  GPIO pin-5 transitions to the QEMU IRQ system end-to-end so
  we can demonstrate "button press triggers ISR" patterns.
- **Phase 2.X**: more peripherals (LEDC PWM, I2C/SPI master).
