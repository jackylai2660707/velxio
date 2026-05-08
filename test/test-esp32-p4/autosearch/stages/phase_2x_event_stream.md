# Phase 2.X — GPIO event stream for the Velxio frontend bridge

**Estado**: ✅ done — `VELXIO_GPIO_LOG=/path/to/file.jsonl` env var
opens a JSON-Lines event log; each pin transition appends one record.
Default build (no env var) is unchanged — zero overhead.

## Goal

Close the loop **emulator ↔ web UI**: when the velxio frontend wants
to display LEDs blinking on screen, it needs a structured event
stream from the emulator. Phase 2.X implements the **emulator-side
producer**; Phase 2.X.next will add the **input direction** (frontend
sends button-press events back to the emulator).

The transport choice was **append-only JSON-Lines file**:
- Trivial to read with `tail -f` from any frontend (Node/Python/web).
- Zero deps on QEMU chardev / socket plumbing.
- Survives across QEMU restarts (file just gets recreated).
- Future replacement (e.g., UDP, WebSocket) is a 5-line drop-in.

## Lo que SE INVESTIGÓ

### 1. Event format

Each line is one JSON object, separated by `\n`:

```json
{"event":"start","source":"esp32p4.gpio","t_ns":0}
{"t_ns":61520525,"pin":5,"level":1}
{"t_ns":166247312,"pin":5,"level":0}
{"t_ns":166286340,"pin":6,"level":1}
...
{"t_ns":3000198645,"pin":0,"level":1}
```

Fields:
- `t_ns` — monotonic nanoseconds since machine init
  (`QEMU_CLOCK_REALTIME - boot_ns`). The first event line emits
  `t_ns:0` so consumers can sync.
- `pin` — GPIO pin number, 0..31.
- `level` — 0 or 1, the new effective level after the transition.

The first record carries `event:"start"` so a tail-fer that joins
mid-stream can detect "this is the beginning of a fresh run" by
seeing a t_ns reset.

### 2. Wall-clock vs. virtual time

`t_ns` uses `QEMU_CLOCK_REALTIME` (host monotonic) so timestamps
match what a human watching the demo would see. Wall-clock locked,
not affected by TCG-busy-wait acceleration of `QEMU_CLOCK_VIRTUAL_RT`
(same lesson learned in Phase 2.W).

Verified: fake button transitions land at exactly t=3.000, 6.000,
9.000 seconds — 1 ms drift each (matches a real 3-second wall-clock
button press cycle).

### 3. Buffering / fflush discipline

Each event line is followed by `fflush(s->event_log)` so consumers
running `tail -f` see each record immediately. Without flush, glibc
buffers up to 4 KB before flushing — the frontend would see events
in batches with multi-second latency, which would defeat the purpose
of the stream.

The trade-off is one extra syscall per pin transition. For ~200
events / 10 s (running light + button), that's negligible host CPU.

## Lo que SÍ funcionó

10-second test run with `VELXIO_GPIO_LOG=/tmp/velxio-gpio.jsonl`:

```
Console output (default human-readable):
  [esp32p4.gpio] event log opened: /tmp/velxio-gpio.jsonl
  [esp32p4] machine init complete ...
  Hello from QEMU ESP32-P4!
  [esp32p4.gpio] pin 5 -> 1
  ... (all pin transitions still emit human lines too)

JSON file (last 15 lines):
  {"t_ns":9027672141,"pin":6,"level":1}
  {"t_ns":9136018757,"pin":6,"level":0}
  ... (running light + button interleaved with monotonic t_ns)

Total events: 207 (matches the human stderr count)
Pin 0 events: t=3.000s, 6.000s, 9.000s (fake button — 3 s period)
Pin 5/6/7 events: ~100 ms apart (running light at ~3.3 Hz cycle)
```

The JSON stream perfectly mirrors the human-readable output, with
machine-parseable structure and accurate wall-clock timestamps.

### 4. Default build verification

Without the env var, the file isn't created and no extra writes
happen. Demo output unchanged:

```
$ ls /tmp/velxio-gpio.jsonl
ls: cannot access '/tmp/velxio-gpio.jsonl': No such file or directory
```

## Frontend usage example

A minimal Node.js consumer (illustrative, not committed):

```js
const fs = require('fs');
const path = process.env.VELXIO_GPIO_LOG ?? '/tmp/velxio-gpio.jsonl';
const tail = fs.createReadStream(path, { encoding: 'utf8' });
let buf = '';
tail.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();  // keep partial line
  for (const line of lines) {
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.event === 'start') {
      console.log('=== new run ===');
    } else {
      console.log(`pin ${ev.pin} → ${ev.level} at ${ev.t_ns/1e9}s`);
    }
  }
});
```

Or with `tail -f` + `jq` from the shell:

```bash
tail -f /tmp/velxio-gpio.jsonl | jq -r '
  if .event == "start" then "--- new run ---"
  else "pin \(.pin) → \(.level) at \(.t_ns/1e9)s" end'
```

## Lessons learned

1. **JSON-Lines is the simplest reliable inter-process stream**:
   newline-delimited, ASCII, append-only, tail-friendly. Frontend
   doesn't need any QEMU-specific knowledge — just a file path.

2. **Always flush after each record for tail-f scenarios**:
   `fflush(s->event_log)` per line is essential. Default glibc
   buffering would batch events with ~4 KB granularity, defeating
   the real-time stream purpose.

3. **`getenv` is the simplest config knob for QEMU device behaviour**:
   no need to add `DEFINE_PROP_STRING` + `-device` cmdline parsing.
   A single env var keeps the cmdline clean and the default
   behaviour identical.

4. **Capture timestamp once per update batch**: when one guest
   write triggers multiple pin transitions (e.g., a multi-bit
   `sw GPIO_OUT_W1TS`), all the resulting transitions share the
   same `t_ns`. Real silicon would report them simultaneously too.

## Implementación final

### `include/hw/gpio/esp32p4_gpio.h`

- Added `FILE *event_log` and `int64_t boot_ns` fields.
- Comment explaining the env-var-gated behaviour.

### `hw/gpio/esp32p4_gpio.c`

- `esp32p4_gpio_update`: emit JSON line per transition, with
  shared `t_ns` for the whole update batch.
- `esp32p4_gpio_realize`: check `getenv("VELXIO_GPIO_LOG")`, open
  the file if set, capture `boot_ns`, write start marker.

## Estado consolidado (post-2.X)

| Hito                                              | Estado       |
|---------------------------------------------------|--------------|
| Hello-world UART demo                             | ✅           |
| 3-pin running light + fake button                 | ✅ Phase 2.V/W |
| GPIO_ENABLE pad multiplexer                       | ✅ Phase 2.W.next |
| **Structured JSON event stream for frontend**     | ✅ Phase 2.X |
| **Wall-clock-accurate timestamps in event log**   | ✅ Phase 2.X |
| Frontend reads stream & shows LEDs (web UI)       | ⏳ Phase 2.X.frontend (UI side) |
| Frontend writes button events back to emulator    | ⏳ Phase 2.X.input |
| Real SYSTIMER-based delays                        | ⏳ Phase 2.Y |
| Pin-transition GPIO interrupts                    | ⏳ Phase 2.Z |

## Próximas fases

- **Phase 2.X.input**: reverse channel — frontend writes JSON
  events to a fifo/socket and the emulator forwards them to
  `external_input` via the GPIO_INPUT_NAME pads. Lets the user
  click a virtual button on the web UI and have the emulator see
  it as a real pin transition.

- **Phase 2.Y**: replace busy-wait delay in the running-light
  blob with `SYSTIMER_UNIT0_VALUE_LO/HI` reads. Current timing
  varies with host CPU; SYSTIMER gives deterministic timing.

- **Phase 2.Z**: pin-transition GPIO interrupts (RISING/FALLING/
  LEVEL) routed through the interrupt matrix to the CPU. Would
  let `attachInterrupt()` work end-to-end.
