# Phase 2.AJ — Guest ISR demo for TIMG (PARTIAL — infrastructure only)

**Estado**: 🔬 done with findings — installed mtvec stub + ISR + MIE
enable in the demo blob. No regression to LEDC/ADC/GPIO event counts.
**ISR does not fire on TIMG IRQ** — CPU trap is intercepted somewhere
in the Phase 2.S CLIC mode dispatch path. Documented as a Phase 2.AK
follow-up.

## Goal

Close the full Arduino `attachInterrupt(timer, isr, EDGE)` chain by
installing a guest-side ISR that:

  1. Clears TIMG INT_CLR (deasserting the IRQ line)
  2. Toggles GPIO pin 8 visibly
  3. mret-returns to interrupted code

Visible result expected: pin 8 transitions exactly once at t≈1 s
(since self-test uses ONE-SHOT alarm to keep the test safe).

## Lo que SE INVESTIGÓ

### 1. Demo blob layout shift

Inserted 5 init instructions at 0x40400128 (between existing init
and old .loop_head):

| Addr        | Asm                          | Encoding   |
|-------------|------------------------------|------------|
| 0x40400128  | `lui  a2, 0x40400`           | 0x40400637 |
| 0x4040012C  | `addi a2, a2, 0x200`         | 0x20060613 |
| 0x40400130  | `csrw mtvec, a2`             | 0x30561073 |
| 0x40400134  | `addi a3, x0, 0x8`           | 0x00800693 |
| 0x40400138  | `csrs mstatus, a3`            | 0x3006A073 |

Loop body shifts +20 bytes; J `.loop_head` offset stays -88 (src+20
== dst+20). `.delay` shifts +20. JAL `+44/+28/+12` offsets unchanged.

### 2. ISR placement and content

Placed at fixed address 0x40400200 (well past .delay which now ends
at 0x404001B8). Eight instructions:

| Addr        | Asm                       | Encoding   | Purpose            |
|-------------|---------------------------|------------|--------------------|
| 0x40400200  | `lui  a2, 0x500BC`        | 0x500BC637 | TIMG0 base         |
| 0x40400204  | `addi a3, x0, 1`          | 0x00100693 | INT_CLR mask       |
| 0x40400208  | `sw   a3, 0x7C(a2)`       | 0x06D62E23 | clear T0 alarm     |
| 0x4040020C  | `lui  a2, 0x500E0`        | 0x500E0637 | GPIO base          |
| 0x40400210  | `lw   a3, 4(a2)`          | 0x00462683 | read OUT_REG       |
| 0x40400214  | `xori a3, a3, 0x100`      | 0x1006C693 | toggle pin 8 bit   |
| 0x40400218  | `sw   a3, 4(a2)`          | 0x00D62223 | write OUT_REG      |
| 0x4040021C  | `mret`                    | 0x30200073 | return from trap   |

Uses a2/a3 (x12/x13) which are unused in the main blob — no save/
restore needed.

Pin 8 ENABLE: changed init mask at 0x40400110 from 0xE0 to 0x1E0
(adds bit 8 to the OUTPUT-enable W1TS write). Without this the GPIO
write would not drive the pin in our model.

### 3. Self-test mode change for safety

Phase 2.AI's self-test used **AUTORELOAD**. If the ISR fails to
clear INT_CLR, AUTORELOAD would re-fire the alarm in ~1 µs (counter
already past alarm) and the CPU would infinite-trap. Risk too high.

Switched to **ONE-SHOT** for Phase 2.AJ: ALARM_EN bit auto-clears on
fire. Worst case: ISR fails, IRQ stays asserted, but no further
fires happen. CPU continues running the demo blob (LEDC/ADC/GPIO).

Cost: only 1 timg event per test instead of 9. Acceptable trade-off.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 335
  "event":"ledc":     99   (Phase 2.AF unchanged)
  "event":"adc":      33   (Phase 2.AD unchanged)
  "event":"start":     1
  "pin":             200   (running light unchanged)

  Timg-related:
    "event":"timg":      1   (one-shot alarm fired)
    "event":"timg_irq":  1   (level=1 transition at t=1.003s)
    "pin":8 events:      0   ← ISR did not fire
```

What this proves:
- ✅ Demo blob still runs (init shift correct, JAL offsets correct)
- ✅ All 5 new init instructions execute (else CPU would have panicked
  on a malformed CSR write before reaching the loop)
- ✅ ISR bytes are installed at 0x40400200 (runtime-patch infrastructure)
- ✅ Pin 8 ENABLE mask write executed (GPIO ENABLE_W1TS now includes 0x100)
- ✅ TIMG self-test alarm fires correctly with one-shot semantics
- ✅ TIMG INT_RAW propagates to CLIC cause 19 (timg_irq event captured)
- ❌ CPU does NOT trap to mtvec on the IRQ → ISR is dead code

## Lo que NO funcionó (root cause hypotheses)

`-d int,guest_errors,unimp` produced no `trap` / `interrupt` lines —
the CPU never enters a trap handler.

**Hypothesis 1 (most likely)**: Phase 2.S installed a CLIC-mode
dispatch path that overrides `write_mtvec` to accept mode 3 and
dispatches via `*(mtvt + cause*4)` instead of mtvec. Even though our
mtvec write contains mode-bits = 0 (0x40400200 has bits[1:0] = 0),
the override may force CLIC mode regardless. Without `mtvt[19]`
populated to point at our ISR address, the CLIC dispatch jumps to
garbage or silently drops.

**Hypothesis 2**: The CLIC has a per-cause enable bitmap
(`clicintctl[N]`) gating which IRQs reach the CPU. Even with TIMG's
own `int_ena=1` and CPU's `mstatus.MIE=1`, if `clicintctl[19] = 0`
the IRQ never reaches mtvec/mtvt dispatch.

**Hypothesis 3**: PMP regions block our ISR address. The `qint.log`
showed many `ignoring pmpcfg write - locked` lines from IDF
initialization. If our ISR at 0x40400200 isn't in an executable PMP
region, the trap-to-ISR fetch would fault — but a fetch fault should
also appear in the int log (it didn't).

### Diagnostics that would discriminate

To diagnose Phase 2.AK, the next session should:

1. Add `qemu_log` to `target/riscv/cpu_helper.c:riscv_cpu_handle_interrupt()`
   (or wherever the CLIC dispatch override lives) to log when ANY
   interrupt is delivered to the CPU.

2. Read mtvt CSR value post-mtvec-write to see if mtvt was changed
   too (by the override).

3. Try writing mtvt directly: encode `csrw mtvt, a2` (CSR 0x307).

4. Check if `clicintctl` is exposed and probe via direct memory write
   to enable cause 19.

## Lessons learned

1. **One-shot self-test is the safe default for ISR experiments**:
   AUTORELOAD + a broken ISR = infinite trap loop. One-shot caps
   the failure cost at 1 alarm event.

2. **CSR encoding is mechanical but error-prone** — verify funct3:
   csrrw=1, csrrs=2, csrrc=3, csrrwi=5, csrrsi=6, csrrci=7. We used
   csrrw and csrrs correctly here. Mismatches cause silent
   acceptance with wrong semantics on most CPUs.

3. **"No trap visible in int log" is not the same as "no IRQ
   generated"**: the IRQ definitely went high (timg_irq event with
   level=1 confirms the qemu_set_irq → CLIC line). The break is
   between CLIC line assertion and CPU trap delivery — i.e., inside
   target/riscv interrupt-handling code.

4. **Infrastructure phases are still valuable**: Phase 2.AJ doesn't
   produce visible pin 8 toggles, but it installs the install-paths
   for ISR / mtvec / MIE in the demo blob. Phase 2.AK can fix one
   more thing (mtvt write or clicintctl enable) and the chain will
   light up. Without 2.AJ those pieces would still need to be built.

## Implementación final

### `hw/riscv/esp32p4.c`

- Self-test changed to one-shot (no AUTORELOAD bit).
- Pin ENABLE mask widened to include pin 8 (0xE0 → 0x1E0).
- 5 new init instructions inserted at 0x40400128.
- Loop body / .delay shifted +20 bytes.
- 8-instruction ISR at fixed address 0x40400200.

Total runtime patches grew from 115 → 128.

## Estado consolidado (post-2.AJ)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| TIMG hardware timer + alarm + DIVIDER respect                  | ✅ 2.AG-AI |
| TIMG → CPU IRQ line wiring (cause 19)                          | ✅ 2.AH|
| **ISR + mtvec + MIE infrastructure installed**                 | ✅ 2.AJ|
| **CPU traps to ISR on TIMG IRQ**                               | ❌ 2.AK|
| TIMG1 + watchdog                                                | ⏳ later|
| I2C / SPI master                                                | ⏳ later|

## 17-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.U   | Hand-rolled GPIO toggle (busy-wait)                     |
| 2.V   | 3-pin running light cycling                             |
| 2.W   | GPIO input + ENABLE multiplexer                         |
| 2.X   | JSON event stream → frontend                            |
| 2.X.in| JSON input fifo ← frontend                              |
| 2.Y   | SYSTIMER virtual-time deterministic timing              |
| 2.Z   | GPIO pin-transition IRQ to CPU                          |
| 2.AA  | INT_TYPE filter + 8-pin wiring                          |
| 2.AB  | Real-silicon shared IRQ + latched INT_STATUS            |
| 2.AC  | LEDC PWM duty-cycle events                              |
| 2.AD  | ADC peripheral + ADC→LEDC pipeline                      |
| 2.AE  | LEDC 2-channel crossfade                                |
| 2.AF  | LEDC 3-channel rainbow                                  |
| 2.AG  | TIMG hardware timer + alarm comparator                  |
| 2.AH  | TIMG → CPU IRQ wiring (cause 19)                        |
| 2.AI  | TIMG DIVIDER respect                                    |
| **2.AJ** | **ISR install path (trap delivery diagnosis pending)** |

JSON stream still carries 6 event types: `start | pin | ledc | adc |
timg | timg_irq`. Pin 8 is now ENABLE-as-output but never written by
the demo blob (only the ISR writes it — and ISR doesn't fire yet).

## Próximas direcciones

- **Phase 2.AK** (highest priority): diagnose CLIC dispatch path.
  Likely fix is writing `mtvt[19] = ISR_address` instead of mtvec,
  OR enabling clicintctl[19] explicitly. Without this, the ISR
  installed by 2.AJ never runs.
- TIMG1 + WDT.
- I2C / SPI master.
- Real PWM waveform on GPIO.
- Real FreeRTOS port (Phase 2.V deferred).
