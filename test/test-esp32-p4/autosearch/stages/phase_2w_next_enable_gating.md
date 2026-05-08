# Phase 2.W.next — GPIO_ENABLE pad-multiplexer enforcement

**Estado**: ✅ done — pins behave like real silicon: `gpio_out` only
drives the pad when `gpio_enable` is set, otherwise `external_input`
wins. Demo updated to enable pins 5/6/7 first (mimics
`pinMode(OUTPUT)`).

## Goal

Lift the GPIO model one step closer to real-silicon behaviour by
enforcing the per-pin output-driver enable bit. In real silicon:

- `pinMode(pin, OUTPUT)` → IDF `gpio_set_direction(pin, OUTPUT)` →
  `GPIO_ENABLE_W1TS_REG = (1<<pin)` → output driver enabled.
- `pinMode(pin, INPUT)` → `GPIO_ENABLE_W1TC_REG = (1<<pin)` →
  driver disabled, pad floats / reads external level.

Phase 2.W's effective-level-OR model treated all pins as "always
drivable from both sides". Phase 2.W.next adds the per-pin
multiplexer.

## Lo que SE INVESTIGÓ

### 1. Pad multiplexer model

Real silicon's pad cell is a 2-input mux gated by enable:

```
                        ┌──────────────┐
                        │              │
    gpio_out ──────────►│  driver      │
                        │  (tristate)  │──── pad ──► external world
                        │              │           ▲
    gpio_enable ───────►│ enable        │           │
                        └──────────────┘           │
                                                   │
                              ┌────────────────────┘
                              ▼
    GPIO_IN ◄────────────  input buffer (always on)
                             reads the pad level — whatever's
                             driving it (output OR external).
```

Implemented as:
```c
effective[N] = (gpio_out[N] & gpio_enable[N])
             | (external_input[N] & ~gpio_enable[N]);
```

- `gpio_enable[N] = 1` → output driver active, pad driven by
  `gpio_out[N]`. External signals would conflict in real silicon
  (we just ignore them).
- `gpio_enable[N] = 0` → driver tristated, pad reads external
  level via `external_input[N]`.

GPIO_IN reads always return the effective level — same as what the
input buffer would see on real silicon.

### 2. Demo blob update

The Phase 2.V running-light blob writes `gpio_out` bits via
`GPIO_OUT_W1TS_REG (0x08)` for pins 5/6/7. With strict ENABLE
gating, those writes would now be muted (effective remains 0)
because `gpio_enable` defaults to 0 (all pins as inputs).

Added 2 instructions at the top of the blob to enable output
drivers for the demo pins:

```
0x40400104: addi t1, x0, 0xE0      ; mask = (1<<5)|(1<<6)|(1<<7)
0x40400108: sw   t1, 0x24(t2)       ; ENABLE_W1TS — enable drivers
```

Encoding `addi t1, x0, 0xE0`:
- imm=0xE0, rs1=0, rd=t1=6, funct3=0, op=0x13
- = (0xE0 << 20) | (0 << 15) | 0 | (6 << 7) | 0x13
- = `0x0E000313`

Encoding `sw t1, 0x24(t2)`:
- imm=0x24, rs2=t1=6, rs1=t2=7, funct3=010
- imm[11:5]=1, imm[4:0]=4
- = (1 << 25) | (6 << 20) | (7 << 15) | (2 << 12) | (4 << 7) | 0x23
- = `0x0263A223`

The 8 added bytes shifted the loop_head from `0x40400104` to
`0x4040010C`. The trailing `j -72` offset stayed the same because
the loop body length didn't change.

## Lo que SÍ funcionó

10-second test:

```
[esp32p4] runtime patches applied (95 entries)
[esp32p4] machine init complete ...
Hello from QEMU ESP32-P4!
[esp32p4.gpio] pin 5 -> 1
[esp32p4.gpio] pin 5 -> 0
[esp32p4.gpio] pin 6 -> 1
... (running light cycles, pins 5/6/7 toggling)
[esp32p4.gpio] pin 0 -> 1   ← fake button (external_input)
... (more running light)
[esp32p4.gpio] pin 0 -> 0
```

Per-pin counts in 10 s:

| Pin | Count | Mode (per ENABLE bit) | Source                |
|-----|-------|------------------------|-----------------------|
| 0   | 3     | INPUT (enable[0]=0)    | external fake button  |
| 5   | 66    | OUTPUT (enable[5]=1)   | running light gpio_out|
| 6   | 65    | OUTPUT (enable[6]=1)   | running light gpio_out|
| 7   | 65    | OUTPUT (enable[7]=1)   | running light gpio_out|

This proves the multiplexer is selecting the correct source per pin
based on the enable bit. **Behaviour matches real ESP32-P4 silicon.**

## Lo que NO funcionó / decisiones tomadas

1. **Considered: drop the OR fallback when enable=0**: i.e., make
   `effective[N] = enable[N] ? gpio_out[N] : external_input[N]`
   strict, no contention handling. Decision: that's what we
   implemented. Real-silicon contention (two drivers fighting) is a
   hardware fault that emulation shouldn't model — emulator picks
   one source deterministically.

2. **Considered: log when guest writes to gpio_out for a disabled
   pin**: would warn about "muted output". Skipped — real silicon
   doesn't warn either, the writes just have no visible effect.
   Could re-add as a debug-mode print if useful for future tooling.

## Lessons learned

1. **Pad multiplexer is a 2-line C expression** — one bit per pin,
   selecting between guest output and external input. The harder
   part is making sure all the helpers (`update`, `read`, `write`,
   `input_handler`) consistently compute "current effective level"
   from the same formula.

2. **Demo needs to mirror Arduino API conventions**: real Arduino
   sketches always call `pinMode(pin, OUTPUT)` before
   `digitalWrite`. Our blob now does the equivalent. Lifting demo
   pieces to mirror what the user-level API expects makes the
   emulator behave more predictably for future Arduino sketch
   testing.

3. **Address shifts when inserting code**: adding 2 instructions at
   the top of a 20-instruction blob shifts all 18 trailing
   addresses by 8 bytes. Mistake-prone if not careful, especially
   for the closing `j` offset that loops back. Verified by hand:
   `0x40400154 - 72 = 0x4040010C` (the new loop_head).

## Implementación final

### `include/hw/gpio/esp32p4_gpio.h`

- Added `gpio_enable` field (alongside `gpio_out`, `external_input`).
- Updated docstring with ENABLE register table (offsets 0x20, 0x24,
  0x28).

### `hw/gpio/esp32p4_gpio.c`

- New `esp32p4_gpio_effective(s)` helper computes the multiplexed
  level for all 32 pins.
- `esp32p4_gpio_update`, `esp32p4_gpio_input_handler`,
  `esp32p4_gpio_write`, and `esp32p4_gpio_read` all use it
  consistently.
- New register decode for ENABLE (0x20), ENABLE_W1TS (0x24),
  ENABLE_W1TC (0x28).
- `gpio_enable` resets to 0 (all pins as inputs, matching real
  silicon's reset state).

### `hw/riscv/esp32p4.c`

- Demo blob extended with `addi t1, 0xE0` + `sw t1, 0x24(t2)` at
  blob entry — enables output drivers for pins 5/6/7 before the
  running light loop starts.
- All trailing instruction addresses shifted +8 bytes; `j -72`
  offset unchanged (loop body length same).

## Estado consolidado (post-2.W.next)

| Hito                                                    | Estado       |
|---------------------------------------------------------|--------------|
| GPIO_OUT_W1TS / W1TC                                    | ✅ Phase 2.W earlier |
| GPIO_IN reads                                           | ✅ Phase 2.W |
| External input pads + fake button                       | ✅ Phase 2.W |
| **GPIO_ENABLE register + pad multiplexer**              | ✅ Phase 2.W.next |
| **Demo enables outputs first (`pinMode(OUTPUT)` style)**| ✅ Phase 2.W.next |
| Open-drain mode / pull-up / pull-down                   | ⏳ later     |
| GPIO interrupt routing (pin transition → CPU IRQ)       | ⏳ later     |
| Frontend bridge (chardev/socket → input pads)           | ⏳ Phase 2.X |
| Real SYSTIMER-based delays                              | ⏳ Phase 2.Y |

## Próximas fases

- **Phase 2.X**: bridge GPIO transitions + input pads to a chardev
  / socket so the velxio frontend can: (a) subscribe to LED
  toggles, (b) inject button presses by writing to the chardev.
  Closes the loop emulator ↔ web UI.

- **Phase 2.Y**: replace busy-wait delay in the running-light blob
  with `SYSTIMER_UNIT0_VALUE_LO/HI` reads. Current timing depends
  on host CPU; SYSTIMER is virtual-time-locked (16 MHz) so timing
  becomes deterministic across hosts.

- **Phase 2.Z** (future): pin-transition GPIO interrupts. Real
  ESP32-P4 supports rising/falling/level-trigger IRQs per pin via
  GPIO_PINx_REG fields. Would let Arduino's `attachInterrupt(pin,
  ISR, RISING)` work end-to-end.
