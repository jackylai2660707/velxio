# AI Assistant (open-source agent)

Chat-driven project generation for Velxio: describe a project in natural
language and the assistant designs the circuit, places and wires components,
writes the firmware, installs libraries, compiles, runs the simulation, and
debugs — live in your editor and canvas. The student can edit anything by
hand between turns; the assistant re-reads the current state on every message.

Open the panel with the **✨ AI 助手** button (bottom-right of the editor).

## Architecture

```
Browser                                        Backend            Anthropic
┌───────────────────────────────────┐   ┌─────────────────┐   ┌───────────┐
│ AgentChatPanel (chat UI)          │   │ /api/agent      │   │ Messages  │
│  └ useAgentStore (history)        │   │  /stream (SSE   │──▶│ API       │
│     └ AgentRunner (agent loop) ───┼──▶│   proxy only)   │◀──│ streaming │
│        └ tools.ts  ──────────────┐│   └─────────────────┘   └───────────┘
│           executes against:      ││
│  useSimulatorStore (components,  ◀┘
│  wires, boards) · useEditorStore │
│  (files) · compile/run via the   │
│  toolbar bridge (agentBridge.ts) │
└───────────────────────────────────┘
```

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
| `compile` / `run_simulation` / `stop_simulation` | Build & run (toolbar bridge) |
| `read_serial` | Tail the board's serial output for verification |

## Setup

1. Install the backend dependency (already in `requirements.txt`):
   `pip install anthropic`
2. Provide an Anthropic API key, either
   - on the server: `export ANTHROPIC_API_KEY=sk-ant-...` (recommended for a
     class/shared instance), or
   - per user: the panel asks for a key and stores it in `localStorage`,
     sending it as an `x-anthropic-key` header.
3. Optional env vars: `VELXIO_AGENT_MODEL` (default `claude-opus-4-8`),
   `VELXIO_AGENT_MAX_TOKENS` (default 16000).

## Key files

- `backend/app/api/routes/agent.py` — SSE streaming proxy (`/api/agent/stream`, `/api/agent/config`)
- `frontend/src/agent/` — `systemPrompt.ts`, `projectSnapshot.ts`, `tools.ts`, `AgentRunner.ts`, `types.ts`
- `frontend/src/store/useAgentStore.ts` — chat state (UI + raw API history)
- `frontend/src/lib/agentBridge.ts` — toolbar compile/run/stop registry
- `frontend/src/components/agent/AgentChatPanel.tsx` — the panel UI
- Tests: `frontend/src/__tests__/agent-tools.test.ts`, `agent-runner.test.ts`

## Known limitations

- Agent mutations use the raw store mutators, which do not push entries onto
  the canvas undo stack (same as example loading) — undo won't revert an
  AI-built circuit step-by-step.
- History is trimmed at ~36 API messages (cut only at user-turn boundaries);
  use “清空” to start a fresh context.
- Panel strings are currently zh/en hardcoded, not routed through i18n.
- The velxio.dev pro overlay injects its own copilot into
  `data-velxio-slot="agent-chat"`; if you build with the overlay you may want
  to hide one of the two panels.
