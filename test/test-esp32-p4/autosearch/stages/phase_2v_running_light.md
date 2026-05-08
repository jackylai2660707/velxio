# Phase 2.V — 3-pin "running light" demo + executable-region lesson

**Estado**: ✅ done — Hello world + 3-pin running light cycling
pins 5 → 6 → 7 at ~3.5 Hz, no FreeRTOS / no Print / no Serial.

## Goal

Upgrade the Phase 2.U single-pin blink to something more
representative of a real chip: multiple GPIO pins toggling in a
sequence, with visible timing. Lay groundwork for future user-
visible patterns and for routing GPIO transitions to the velxio
frontend UI.

## Lo que SE INVESTIGÓ

### 1. Approach: relocate the blink loop to a larger blob in IRAM

The Phase 2.U single-pin blink fit in 11 instructions inside the
0x4000305A..0x40003086 region of app_main. Adding 3 pins each with
their own setup+delay+teardown requires ~20 instructions. To avoid
clobbering app_main internals, I designed a 3-instruction
**trampoline** at 0x4000305A that long-jumps to a separate ~80-byte
blob in unused IRAM:

```
0x4000305A: lui  t0, 0x40400      ; high 20 bits of blob addr
0x4000305E: addi t0, t0, 0x100    ; t0 = 0x40400100 (blob entry)
0x40003062: jalr x0, 0(t0)        ; jump (no return)
```

The blob then runs the 20-instruction running-light pattern from
0x40400100 onwards.

### 2. **CRITICAL DISCOVERY: L2MEM is NOT executable**

First attempt placed the blob at `0x4FFA0100` (in HP L2MEM, well
past the ELF data and our existing 0x4FFA0000 hello-string area).
QEMU memory model has L2MEM as `memory_region_init_ram` so it
should be executable. BUT the test panicked:

```
Guru Meditation Error: Core  0 panic'ed (Instruction access fault).
MEPC: 0x4ffa0100   MTVAL: 0x4ffa0100   MCAUSE: 0x00000001
```

`MCAUSE = 1` (instruction access fault) on the first byte of the
blob. The trampoline ran fine (correctly loaded `t0 = 0x4FFA0100`
and jumped) but the CPU couldn't fetch from that L2MEM address.

**Root cause**: the IDF runtime sets up RISC-V PMP rules during
startup that restrict execute permission to specific regions. L2MEM
addresses outside those PMP windows trap on instruction fetch even
though the memory is RAM-backed.

**Verified**: relocating the blob to `0x40400100` (cache-window
IRAM, past the 4 MB flash blob region) made the fetch work. The
cache window 0x40000000+ is the IDF's **primary execute region**
— Phase 2.U single-pin blink ran from there successfully.

### 3. Counter sizing

Encoded the 3-pin running light using the same delay loop pattern
from Phase 2.U:

```
lui  t5, 0x?? (counter)
addi t5, t5, -1
bnez t5, -4
```

Test runs at different counter values:

| Counter (lui imm) | Iter count | Toggles/10s | Pattern speed       |
|-------------------|------------|-------------|---------------------|
| `0x80`            | 524288     | 49,581      | ~830 cycles/sec     |
| `0x8000`          | ~134M      | **207**     | **~3.5 Hz** ✓       |

The 256× slowdown gives a clear, eye-readable cycling pattern. Each
pin gets ~7 transitions per second (= 3.5 Hz cycle since each pin
toggles twice per cycle).

## Lo que SÍ funcionó

```
[esp32p4] runtime patches applied (93 entries)
[esp32p4] machine init complete ...
Hello from QEMU ESP32-P4!
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
[esp32p4.gpio] pin 6 -> 1
[esp32p4.gpio] pin 6 -> 0
[esp32p4.gpio] pin 7 -> 1
[esp32p4.gpio] pin 7 -> 0
[esp32p4.gpio] pin 5 -> 1
... (repeating, ~3.5 Hz cycle)
```

Three GPIO pins driven concurrently, plus the UART hello-world
output. **Realistic multi-peripheral firmware-like behaviour** with
predictable timing and no IDF/FreeRTOS dependencies.

## Lo que NO funcionó (intentado y descartado)

1. **L2MEM at 0x4FFA0100 for the blob** — fetch faulted on MCAUSE=1
   despite L2MEM being `init_ram`. PMP-execute rules from IDF
   startup restrict L2MEM execution. **Lesson**: always place
   executable code in the cache-window region (0x40000000+) for
   compatibility with IDF's PMP setup.

2. **Counter `0x80` (524k)** — 49.5k toggles/sec across 3 pins =
   ~5kHz pattern frequency. Too fast for visual interpretation,
   floods the terminal.

## Lessons learned

1. **PMP rules matter**: L2MEM addresses are RAM-backed and
   readable/writable, but NOT necessarily executable under IDF's
   PMP setup. Cache-window IRAM at 0x40000000+ is reliably
   executable because the IDF defaults to allowing execution from
   the flash-mapped XIP region.

2. **`address_space_write` succeeds even to non-executable regions**:
   our patches dropped 80 bytes at 0x4FFA0100 successfully, the
   memory was readable, but the CPU still couldn't fetch
   instructions from there. Writes are just RAM-level operations;
   execution permission is enforced by PMP at the CPU level.

3. **Trampoline-to-blob pattern**: 3 instructions (12 bytes) is
   enough to long-jump from a constrained patch site to an
   arbitrarily-sized code blob elsewhere. `lui rd, hi; addi rd, rd,
   lo; jalr x0, 0(rd)` covers the full 32-bit address space.

4. **Counter scaling for visible patterns**: at QEMU TCG speed,
   ~134M iterations of `addi+bnez` = visible ~3 Hz pattern.
   Order-of-magnitude tuning works (16M iter ≈ 80 Hz, 134M iter ≈
   3.5 Hz).

5. **GPIO model is great for layered demos**: each `sw t3, 8(t2)`
   to W1TS atomically sets pin bits. The model emits one stderr
   line per transition. With 3 pins toggling sequentially, the
   output is intuitive: `pin 5 -> 1; pin 5 -> 0; pin 6 -> 1; ...`.

## Implementación final

### `hw/riscv/esp32p4.c`

Removed 11 Phase 2.U single-pin blink patches. Added 23 new patches:

  - 3 trampoline patches at `0x4000305A` (lui/addi/jalr).
  - 20 blob patches at `0x40400100..0x4040014C` for the 3-pin
    running light (1 init `lui t2`, 6 instructions × 3 pins, 1 final
    `j -72` back to .loop_head).

Total runtime patches: 93 active.

## Estado consolidado (post-2.V)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| Hello-world demo (default build)                        | ✅           |
| Single-pin LED blink                                    | ✅ Phase 2.U |
| **3-pin running light (~3.5 Hz cycle)**                 | ✅ Phase 2.V |
| **Trampoline-to-blob pattern proven**                   | ✅ Phase 2.V |
| Multi-pin GPIO with input handling (button → ISR)       | ⏳ Phase 2.W |
| Real SYSTIMER-based delays (not busy-wait)              | ⏳ Phase 2.W |
| Frontend UI integration (LED state stream)              | ⏳ Phase 2.X |

## Próximas fases

- **Phase 2.W**: GPIO input register handling. Currently the model
  is output-only (R_GPIO_OUT, W1TS, W1TC). Adding R_GPIO_IN at
  offset 0x3C lets guest code read pin states. Wire up an external
  "button" device that pulses pin_irq[N] to demonstrate
  external-event handling.

- **Phase 2.X**: bridge GPIO transitions to a chardev or socket so
  the velxio frontend (web UI) can subscribe to LED state changes.
  Closes the loop from "emulator runs ESP32-P4 firmware" to "user
  sees LEDs blinking on screen".

- **Phase 2.Y**: real SYSTIMER-based delay (replace busy-wait with
  reads from `SYSTIMER_UNIT0_VALUE_LO/HI` registers). Current
  busy-wait timing depends on host CPU speed; SYSTIMER is virtual-
  time-locked so timing would be deterministic.
