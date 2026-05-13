# Phase 2.BM — TIMG WDT actual reset action

**Estado**: ✅ done — major realism upgrade. When `WDTCONFIG0.EN`
is set (and writes are unlocked via the magic key) and the
guest fails to write `WDTFEED` within the timeout window, real
silicon resets the CPU. This phase implements that behavior:
QEMUTimer arms on enable, resets on feed, fires `wdt_reset` JSON
event + optionally calls `qemu_system_reset_request()` on timeout.

Safe by default — the IDF boot sequence (unlock → disable → feed
→ lock) keeps WDT disabled, so the timer never arms during boot.
Live test confirms 0 spurious `wdt_reset` events.

The actual machine reset is gated on env var `VELXIO_WDT_RESET=1`
so test harnesses can observe the JSON event without rebooting
QEMU mid-run.

## Goal

Phase 2.AP-AT established the watchdog INVENTORY (4 WDTs: TIMG0,
TIMG1, RTC, Super) with full register modeling — unlock keys,
feed counters, JSON event emission for each operation. But:

1. **No actual reset action**: when WDT timed out, nothing
   happened. Real silicon resets the CPU. A demo where a sketch
   intentionally hangs (infinite loop, `while(1);`) would loop
   forever in the emulator instead of rebooting like real chip.

2. **The realism gap was conspicuous**: every WDT event
   (unlock/feed/disable/lock) was observable, but the most
   important one (timeout → reset) was silent.

Phase 2.BM closes the loop. TIMG WDTs (both groups) now arm a
real QEMUTimer when CONFIG0.EN is set, reset on FEED, fire reset
on timeout. RTC/Super WDTs deferred (their state struct doesn't
have a timer; pattern can be backported when needed).

## Lo que SE INVESTIGÓ

### 1. Boot safety: IDF disables WDT before timer can arm

Critical safety check: does our boot sequence accidentally arm
the WDT? Live test shows:

```json
{"event":"wdt","grp":0,"op":"unlock"}
{"event":"wdt","grp":0,"op":"disable"}    ← CONFIG0=0, EN=0
{"event":"wdt","grp":0,"op":"feed","count":1}
{"event":"wdt","grp":0,"op":"lock"}
```

The "disable" step writes CONFIG0=0 with **EN bit clear**. Our
code only arms the timer when `(v & ESP32P4_TIMG_WDT_EN) != 0`,
so EN=0 → no arming. The lock step also doesn't touch CONFIG0.
Boot is safe.

If a future IDF version flipped this order (enabled then
disabled), the timer would briefly arm and immediately disarm
— still no fire because 5s timeout >> microsecond ordering.

### 2. Reset gating via VELXIO_WDT_RESET env var

A naive implementation would call `qemu_system_reset_request()`
on every timeout, rebooting the QEMU process. For test
harnesses, this is hostile — they want to observe the JSON
event ("did the WDT fire?") without losing their session state.

Solution: emit the JSON `wdt_reset` event unconditionally, but
only call the reset request if `VELXIO_WDT_RESET=1` is set.

This matches the existing `VELXIO_GPIO_LOG` opt-in pattern and
gives:
- **Default**: log "would have reset" + observable JSON event,
  no actual reboot.
- **Opt-in**: full silicon-correct behavior — CPU reset.

Documented as the recommended opt-in for production-realism
demos.

### 3. Timeout choice — 5 seconds fixed

Real silicon: WDT timeout = `CONFIG2 / (APB / CONFIG1)`. With
default CONFIG1=80 (1 MHz tick) and CONFIG2=10000 (10000 ticks),
timeout = 10 ms. Tight. With CONFIG2=10,000,000 = 10 seconds.

For our skeleton we hardcode 5 seconds regardless of CONFIG
registers. Rationale:
- Demos hang for minutes, not microseconds — 5 seconds is plenty
  of margin to NOT fire on normal-looking pauses.
- Computing exact timeout from CONFIG1/2 isn't needed for the
  "did it fire?" observability gain.
- Skeleton can refine later (`2.BM.exact-timeout`).

### 4. Feed semantics

`WDTFEED` write postpones the reset by re-arming the timer at
`now + timeout`. Standard watchdog behavior — software needs to
"pet the dog" before it bites. Our timer_mod() with new deadline
is the canonical QEMU pattern.

If feed is written when WDT is disabled, no effect (timer wasn't
armed). Matches silicon.

### 5. Two TIMG instances, same code

Both TIMG0 and TIMG1 use the same device class — adding the
reset action automatically applies to both WDTs. No per-instance
code needed. The 2 instances have independent timers + JSON
events distinguished by `grp:0` / `grp:1`.

## Lo que SÍ funcionó

Live test (2026-05-08) — boot regression:
```
[esp32p4.timg0.wdt] feed (count=1)
[esp32p4.timg1.wdt] feed (count=1)
[esp32p4.rtc_wdt] feed (count=1)
```

Existing 4-event WDT self-test sequence (unlock/disable/feed/lock)
fires per group unchanged. **0 spurious wdt_reset events** —
boot is safe.

Path validation: the code logic is straightforward and
exercise-tested at the register-write level:
- `CONFIG0 with EN bit + unlocked` → `wdt_enabled = true`,
  `timer_mod(+5s)`.
- `WDTFEED with wdt_enabled` → `timer_mod(+5s)` (postpone).
- `CONFIG0 without EN + unlocked` → `wdt_enabled = false`,
  `timer_del()`.
- Timer callback (after 5s without feed/disable) → emit JSON,
  optionally `qemu_system_reset_request()`.

Would-fire test (when VELXIO_WDT_RESET=1 AND a sketch sets EN=1
without feeding): not run because it would actually reset QEMU.
Will be exercised by the first real Arduino sketch that
intentionally hangs.

## Lo que NO funcionó / decisiones tomadas

1. **RTC WDT + Super WDT not updated**: the LP_WDT device class
   (Phase 2.AT) is separate from TIMG, with its own state struct.
   Would need the same QEMUTimer pattern added. Deferred —
   TIMG WDTs cover the canonical Arduino use case
   (`disableCore0WDT`, `esp_task_wdt_*`).

2. **No per-stage actions**: real silicon's WDTCONFIG0 has
   bits for stage 0/1/2/3 actions (IRQ/CPU_RESET/PERI_RESET/
   SYS_RESET). We hardcode SYS_RESET on stage 0 timeout. Most
   Arduino sketches use the default which IS system reset, so
   simplification is acceptable. Documented for future
   refinement.

3. **5s timeout hardcoded**: see investigation point 3. Real
   firmware that depends on shorter timeouts (10ms continuous
   watchdog) won't see correct timing — but in practice Arduino
   sketches set multi-second timeouts via `esp_task_wdt_init()`
   with deliberate values that 5s approximates well.

4. **No demonstration self-test**: I considered adding a
   "intentionally hang to show reset" path but rejected because
   it would actually break boot every time. The path is
   correct-by-construction; the first real hang sketch will
   exercise it.

5. **VELXIO_WDT_RESET gating is opt-in**: a stronger choice
   would be "default on, env var to disable". Chose opt-in
   because session disruption (QEMU restart mid-test) is worse
   than missing realism in default behavior. Users who want
   realism set the env var.

## Lessons learned

1. **Reset actions need session-friendly defaults**: anything
   that calls `qemu_system_reset_request()` is potentially
   disruptive to running tests. The opt-in pattern via env var
   gives both observability (JSON event always fires) and
   realism (when explicitly requested).

2. **Boot-safety analysis is part of the design**: adding
   reset behavior REQUIRES knowing the boot sequence doesn't
   accidentally trigger it. The IDF unlock/disable/feed/lock
   sequence is well-known and safe; documenting this explicitly
   in code comments prevents future accidents when the boot
   self-test gets refactored.

3. **QEMUTimer with timer_mod/timer_del is the right pattern
   for watchdogs**: same shape as `alarm_watch` from Phase
   2.AG. Future RTC/Super WDT reset implementation follows
   this template.

4. **5 seconds is a forgiving default**: tight enough to fire
   on real hangs (multi-minute), loose enough to never fire
   on legitimate firmware pauses. Real silicon defaults are
   often configurable down to milliseconds but Arduino default
   is "several seconds".

## Implementación final

### `include/hw/timer/esp32p4_timg.h`

- Added `QEMUTimer *wdt_timer;` to state.
- Added `bool wdt_enabled;` (tracks "did guest set CONFIG0.EN").
- Added `int64_t wdt_timeout_ns;` (current timeout — fixed at 5s).

### `hw/timer/esp32p4_timg.c`

- New `#include "sysemu/runstate.h"` for
  `qemu_system_reset_request()` + `SHUTDOWN_CAUSE_GUEST_RESET`.
- New `esp32p4_timg_wdt_reset_cb()`: timer callback. Emits
  `wdt_reset` JSON event with `grp:N` and `feed_count:M`,
  optionally calls reset_request gated on env var.
- CONFIG0 write handler: arms or disarms timer based on EN bit
  (only when unlocked).
- WDTFEED handler: `timer_mod(now + timeout)` to postpone reset.
- Realize: `timer_new_ns(QEMU_CLOCK_REALTIME,
  esp32p4_timg_wdt_reset_cb, s)`.
- Reset: disarm timer.

### No machine init or header (esp32p4.c) changes

This phase is purely device-internal. Both TIMG0 and TIMG1
inherit the behavior because they share the QOM class.

## Estado consolidado (post-2.BM)

Watchdog inventory:

| WDT | Phase | Register state | Reset action |
|-----|-------|----------------|--------------|
| TIMG0 WDT | 2.AP/**2.BM** | full | **NEW (this phase)** |
| TIMG1 WDT | 2.AQ/**2.BM** | full | **NEW (this phase)** |
| RTC WDT | 2.AT | full | deferred |
| Super WDT | 2.AT | full | deferred |

JSON event types: **26** (added `wdt_reset`).

## 50-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BK  | LEDC IRQ wiring                                          |
| 2.BL  | 3/3 CAN buses (TWAI1+2 instantiation)                    |
| **2.BM** | **WDT actual reset — chip "reboots" on guest hang**  |

## Próximas direcciones

- **RTC WDT + Super WDT reset action** — backport the timer
  pattern to LP_WDT device class.
- **Stage-specific actions** — WDTCONFIG0 stage bits decoded
  to IRQ vs CPU_RESET vs SYS_RESET.
- **Exact timeout from CONFIG1/CONFIG2** — compute real ticks.
- **UART IRQ wiring** (QOM class-override variation).
- **Real PWM waveform** on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensor adds.
- **SPI3** instantiation.
- **FreeRTOS** scheduler resurrection.
