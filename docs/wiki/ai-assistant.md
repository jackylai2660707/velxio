# AI Assistant (open-source agent)

Chat-driven project generation for Velxio: describe a project in natural
language and the assistant designs the circuit, places and wires components,
writes the firmware, installs libraries, compiles, runs the simulation, and
debugs — live in your editor and canvas. The student can edit anything by
hand between turns; the assistant re-reads the current state on every message.

Open the panel with the **AI** button at the far right of the editor
toolbar (mobile: the AI tab in the top tab bar). The panel docks to the right
edge — the canvas shrinks to make room, so it never overlaps the minimap,
zoom controls, or other floating UI — and its width is drag-resizable.

**OpenAI-compatible endpoints only.** The panel's settings view (gear icon)
lets each user set base URL, API key, model (with a model list fetched from
the upstream `/models`), and reasoning effort — stored in localStorage and
sent per request; anything left blank falls back to the server's environment
defaults. A connection-test button runs a one-shot completion via
`POST /api/agent/test`.

Safety & transparency features:

- **Per-turn checkpoints** — every user message captures the full project
  (boards, components, wires, files); a ⟲ button on the message rolls the
  whole project back.
- **Verified results** — the assistant is instructed (and equipped) to
  OBSERVE the simulation before claiming success: `observe_simulation`
  reports LED blink rates, servo angles, decoded LCD/7-segment/OLED content,
  pin levels, and the serial output produced during the window; `interact`
  presses buttons and drives sensor values (e.g. push a DHT22 past an alarm
  threshold) and reports a before → after diff of all outputs.
- **Steering** — the composer stays live while the agent works: Enter queues
  a message that is injected into the current run after the ongoing tool
  batch (or promoted to a follow-up turn when the run would end).
- **Diff cards** — `write_file`/`edit_file` render a colored line diff of
  exactly what changed.
- **Example-grounded prompting** — the request is matched against the
  built-in example gallery (bilingual keywords) and the best-matching
  circuit's wiring rides along as a reference; `search_examples` /
  `get_example` retrieve further references on demand.
- **Context compaction** — stale `<project_state>` snapshots are stripped
  from older turns on the wire, and when the context approaches the model's
  limit (settings → context limit) older turns are summarized BY the model
  into a `<context_summary>` block; structural trimming remains the fallback.
- **History integrity** — aborts, stream errors, and mid-run page reloads
  leave the tool-call history pair-complete (`historyRepair.ts`), so a
  conversation can always continue.
- **Chat persistence** — conversation survives a page refresh
  (localStorage); token usage per turn is displayed.
- **Project version history** — git-style linear snapshots in IndexedDB
  (`frontend/src/versioning/`): saved automatically before every AI turn,
  manually from the 🕘 button in the file explorer, and as a safety backup
  before any restore. Up to 50 versions; manual saves are never pruned. The
  AI can drive it too (`save_version` / `list_versions` / `restore_version`
  — restore requires the student's explicit confirmation first).
- **Teaching mode** — the system prompt distinguishes questions from build
  requests: questions get beginner-friendly answers grounded in the
  student's own circuit/code (no project mutation), with an offer to
  demonstrate live in the simulation.
- **Wiring & layout standards** (behavior-tested, defaults-not-force):
  `add_wire` classifies every wire's signal type (pinInfo `signals` +
  pin-name fallback, `agent/wireStandards.ts`) and applies the standard
  `WIRE_COLORS` palette when the model omits `color` (explicit colors are
  respected; `signalType` is stored either way). `add_component` snaps
  coordinates to the 20px grid, reports each element's REAL rendered size,
  and auto-nudges downward out of accidental overlaps — the one thing the
  model cannot know is element footprints.

## Architecture

```
Browser                                        Backend            OpenAI-compatible
┌───────────────────────────────────┐   ┌─────────────────┐   ┌───────────┐
│ AgentChatPanel (chat UI)          │   │ /api/agent      │   │ chat/     │
│  └ useAgentStore (history)        │   │  /stream (SSE   │──▶│ completions│
│     └ AgentRunner (agent loop) ───┼──▶│   proxy only)   │◀──│ streaming │
│        └ tools.ts  ──────────────┐│   └─────────────────┘   └───────────┘
│           executes against:      ││
│  useSimulatorStore (components,  ◀┘
│  wires, boards) · useEditorStore │
│  (files) · compile/run via the   │
│  toolbar bridge (agentBridge.ts) │
└───────────────────────────────────┘
```

The loop is event-driven (Pi-style): `AgentRunner.runTurn()` emits a typed
`AgentEvent` stream (`agent/events.ts`) consumed by a pure UI reducer
(`agent/uiReducer.ts`); tools receive a per-call context
(`{ toolCallId, signal, onUpdate }`) so long compiles stream their log tail
into the running chip and aborts propagate cleanly.

Design decisions (informed by pi, Codex CLI, Cline, and the Vercel AI SDK
client-tool pattern):

- **The agent loop runs in the browser.** All project state lives in the
  frontend Zustand stores (the OSS backend is stateless), so tools execute
  client-side against those stores. The backend only relays one streaming
  Messages API call per round and holds the API key.
- **Cline-style state injection.** A `<project_state>` snapshot (boards,
  components, wires, full file contents) is injected at the start of every
  user turn. Manual edits made between turns are therefore always visible to
  the model. A `get_project` tool re-reads state mid-turn.
- **Domain-shaped tools, not a whole-diagram document.** Each mutation
  (`add_component`, `add_wire`, `edit_file`, …) is an individual store action
  the student sees happen on canvas. Pin names are validated against the
  live element `pinInfo` before a wire is accepted.
- **pi-style `edit_file`.** Exact-string replacement that must match exactly
  once — the safe way to modify code the student may have edited by hand.
- **Compile feedback loop.** `compile` / `run_simulation` call the *same*
  toolbar handlers as the buttons (via `lib/agentBridge.ts`), and compiler
  errors stream back to the model, which fixes the code and retries.

## Tools

| Tool | Purpose |
|---|---|
| `get_project` | Re-read full project state |
| `list_component_types` | Search the ~160-part catalog |
| `get_pins` | Pin names of a board/component (live `pinInfo`) |
| `add_board` / `remove_board` / `set_active_board` | Board management |
| `set_board_language` | Arduino C++ ↔ MicroPython |
| `add_component` / `update_component` / `remove_component` | Canvas parts |
| `add_wire` / `remove_wire` | Wiring (pin-validated) |
| `write_file` / `edit_file` / `delete_file` | Firmware files (per-board group) |
| `install_library` | arduino-cli library install + board manifest |
| `compile` / `run_simulation` / `stop_simulation` | Build & run (toolbar bridge; compile failures carry recovery hints) |
| `read_serial` | Tail the board's serial output for verification |
| `observe_simulation` | Sample live component state over a window: LED toggles/Hz, servo sweep, buzzer duty, LCD/7-seg/OLED/MAX7219-matrix decode, pin levels, burnt parts, serial delta |
| `interact` | Press/click buttons, set pot/switch values, drive sensor readings (`SENSOR_CONTROLS`-validated) — with a before → after output diff |
| `check_circuit` | SPICE pre-flight verification (missing GND, LED without resistor, shorts, …) before running |
| `search_libraries` | Arduino library registry search (exact installable names) |
| `search_examples` / `get_example` | On-demand retrieval from the ~500-project example gallery (full wiring + code) |
| `save_version` / `list_versions` / `restore_version` | Project version history (IndexedDB; restore needs explicit user confirmation) |

## Setup

Server-side environment defaults (all optional — users can also configure
everything from the panel settings):

```bash
VELXIO_OPENAI_BASE_URL=https://api.example.com/v1
VELXIO_OPENAI_API_KEY=sk-...
VELXIO_AGENT_MODEL=gpt-4o
VELXIO_AGENT_EFFORT=high                # reasoning_effort for reasoning models
VELXIO_SKIP_ARDUINO_INDEX=1             # skip arduino-cli's startup index fetch
```

Per-user keys travel in the `x-agent-key` header and are stored only in the
browser's localStorage.

## Key files

- `backend/app/api/routes/agent.py` — SSE streaming proxy (`/api/agent/stream`, `/api/agent/config`)
- `frontend/src/agent/` — `systemPrompt.ts`, `projectSnapshot.ts`, `tools.ts`,
  `AgentRunner.ts`, `events.ts`, `uiReducer.ts`, `AgentSession.ts` (steering),
  `observation.ts`, `interaction.ts`, `compaction.ts`, `historyRepair.ts`,
  `exampleSearch.ts`, `errorHints.ts`, `types.ts`
- `frontend/src/store/useAgentStore.ts` — chat state (UI + raw API history)
- `frontend/src/lib/agentBridge.ts` — toolbar compile/run/stop registry
- `frontend/src/components/agent/AgentChatPanel.tsx` — the panel UI
- Tests: `frontend/src/__tests__/agent-*.test.ts` (tools, runner, reducer,
  verification, compaction, history repair)

## Known limitations

- Agent mutations use the raw store mutators, which do not push entries onto
  the canvas undo stack — use the per-turn ⟲ checkpoint button to roll back
  a whole turn instead.
- Panel strings are localized for en + zh-CN; other locales fall back to
  English.
- The velxio.dev pro overlay injects its own copilot into
  `data-velxio-slot="agent-chat"`; if you build with the overlay you may want
  to hide one of the two panels.
