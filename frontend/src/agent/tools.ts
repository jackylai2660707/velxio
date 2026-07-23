/**
 * AI assistant tool surface.
 *
 * Every tool executes in the browser against the live Zustand stores — the
 * same mutations the UI itself performs — so anything the assistant builds
 * is immediately visible, editable, and undoable by the student, and
 * anything the student changed by hand is what the assistant reads back.
 */

import registry from '../services/ComponentRegistry';
import { installLibrary, searchLibraries } from '../services/libraryService';
import { getToolbarActions } from '../lib/agentBridge';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { verifyCircuitFromStore } from '../simulation/verify/verifyFromStore';
import { BOARD_KIND_LABELS, type BoardKind } from '../types/board';
import type { Wire } from '../types/wire';
import { buildProjectSnapshot } from './projectSnapshot';
import { lineDiff } from './diff';
import { observeSimulation, MAX_OBSERVE_MS } from './observation';
import { interact, type InteractAction } from './interaction';
import { searchExamplesText, getExampleText } from './exampleSearch';
import { compileErrorHints } from './errorHints';
import { useVersionStore } from '../versioning/useVersionStore';
import { classifyWire } from './wireStandards';
import { WIRE_COLORS } from '../utils/wireColors';
import { BOARD_SIZE } from '../types/boardSizes';
import type { ToolDefinition } from './types';

// ── Helpers ────────────────────────────────────────────────────────────────

class ToolError extends Error {}

/** Wait two animation frames so React has mounted newly-added elements
 *  before we read pinInfo from the DOM or recalc wire positions. */
function settleDom(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') return resolve();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

interface PinDescriptor {
  name: string;
  description?: string;
  /** wokwi PinSignalInfo — feeds wire signal classification when present */
  signals?: unknown[];
}

type RawPin = { name: string; description?: string; signals?: unknown[] };

const toPinDescriptor = (p: RawPin): PinDescriptor => ({
  name: p.name,
  description: p.description,
  signals: Array.isArray(p.signals) ? p.signals : undefined,
});

/**
 * Resolve the pin list for a canvas id (component/board) or a catalog type.
 * Returns null when pins can't be determined (element not mounted yet, or
 * the custom element class isn't loaded) — callers treat that as "soft ok".
 */
function resolvePins(target: string): PinDescriptor[] | null {
  // 1. Live element on the canvas (components AND boards render with DOM id = store id)
  if (typeof document !== 'undefined') {
    const el = document.getElementById(target) as (HTMLElement & { pinInfo?: unknown }) | null;
    if (el && Array.isArray(el.pinInfo)) {
      return (el.pinInfo as RawPin[]).map(toPinDescriptor);
    }
  }
  // 2. Catalog type → instantiate the custom element off-DOM and read pinInfo
  const meta = registry.getById(target);
  if (meta && typeof document !== 'undefined' && typeof customElements !== 'undefined') {
    if (customElements.get(meta.tagName)) {
      try {
        const el = document.createElement(meta.tagName) as HTMLElement & { pinInfo?: unknown };
        if (Array.isArray(el.pinInfo)) {
          return (el.pinInfo as RawPin[]).map(toPinDescriptor);
        }
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/** Same lenient matching the wire renderer uses (GND → GND.1 variants). */
function pinExists(pins: PinDescriptor[], pinName: string): boolean {
  if (pins.some((p) => p.name === pinName)) return true;
  if (!pinName.includes('.') && pins.some((p) => p.name === `${pinName}.1`)) return true;
  if (pinName.startsWith('GP')) {
    const n = parseInt(pinName.slice(2), 10);
    if (!Number.isNaN(n) && pins.some((p) => p.description === `GPIO${n}`)) return true;
  }
  return false;
}

/** Recalculate wire endpoints from live pinInfo. No-op outside a browser
 *  (the store helper reads the DOM unguarded). */
function safeRecalcWires(): void {
  if (typeof document === 'undefined') return;
  useSimulatorStore.getState().recalculateAllWirePositions();
}

/** Briefly glow a canvas element so the student sees WHERE the AI just
 *  placed something. Best-effort visual sugar. */
function flashCanvasElement(id: string): void {
  if (typeof document === 'undefined') return;
  try {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.style.boxShadow;
    el.style.transition = 'box-shadow 0.3s ease';
    el.style.boxShadow = '0 0 0 4px rgba(79, 193, 255, 0.75)';
    setTimeout(() => {
      el.style.boxShadow = prev;
      setTimeout(() => {
        el.style.transition = '';
      }, 400);
    }, 1400);
  } catch {
    /* purely cosmetic */
  }
}

function resolveBoard(boardId?: string) {
  const sim = useSimulatorStore.getState();
  const id = boardId ?? sim.activeBoardId;
  const board = sim.boards.find((b) => b.id === id);
  if (!board) {
    const available = sim.boards.map((b) => b.id).join(', ') || '(none)';
    throw new ToolError(
      `Board "${boardId ?? '(active)'}" not found. Boards on canvas: ${available}. ` +
        `Add one with add_board first.`,
    );
  }
  return board;
}

function findGroupFile(groupId: string, name: string) {
  return useEditorStore
    .getState()
    .getGroupFiles(groupId)
    .find((f) => f.name === name);
}

function uniqueComponentId(type: string): string {
  const sim = useSimulatorStore.getState();
  const taken = new Set([...sim.components.map((c) => c.id), ...sim.boards.map((b) => b.id)]);
  let n = 1;
  while (taken.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

let wireCounter = 0;
function uniqueWireId(): string {
  const taken = new Set(useSimulatorStore.getState().wires.map((w) => w.id));
  let id: string;
  do {
    id = `wire-ai-${++wireCounter}`;
  } while (taken.has(id));
  return id;
}

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Real rendered size of a mounted canvas element (unscaled layout px). */
function measureEl(id: string): { w: number; h: number } | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el) return null;
  const w = el.offsetWidth || el.getBoundingClientRect().width;
  const h = el.offsetHeight || el.getBoundingClientRect().height;
  return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
}

interface CanvasRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rects of everything already on the canvas (boards + components), using
 *  real DOM sizes where available. Positions come from the store (DOM rects
 *  are affected by canvas zoom; store coords are not). */
function occupiedRects(excludeId: string): CanvasRect[] {
  const state = useSimulatorStore.getState();
  const rects: CanvasRect[] = [];
  for (const b of state.boards) {
    const size = BOARD_SIZE[b.boardKind] ?? { w: 300, h: 220 };
    rects.push({ id: b.id, x: b.x, y: b.y, w: size.w, h: size.h });
  }
  for (const c of state.components) {
    if (c.id === excludeId) continue;
    const size = measureEl(c.id);
    if (size) rects.push({ id: c.id, x: c.x, y: c.y, ...size });
  }
  return rects;
}

const rectsOverlap = (a: CanvasRect, b: CanvasRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ── Tool definitions (sent to the model) ───────────────────────────────────

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_project',
    description:
      'Re-read the CURRENT project state (boards, components, wires, all code files). ' +
      'Call this after several mutations, or whenever you are unsure of the current state. ' +
      'A fresh snapshot is also injected automatically at the start of every user message.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_component_types',
    description:
      'Search the catalog of ~160 available component types (LEDs, resistors, sensors, displays, ' +
      'motors, logic gates, …). Returns type ids to use with add_component. ' +
      'Call this before adding a component unless you already know its exact type id.',
    input_schema: {
      type: 'object',
      properties: {
        query: str('Search term, e.g. "led", "ultrasonic", "oled", "servo". Empty = list categories.'),
      },
    },
  },
  {
    name: 'get_pins',
    description:
      'List the pin names of a component/board. Target is a canvas id (e.g. "arduino-uno", ' +
      '"led-red-1") or a catalog type id (e.g. "wokwi-hc-sr04"). ALWAYS check pin names before ' +
      'wiring anything you have not wired before — wrong pin names leave wires dangling.',
    input_schema: {
      type: 'object',
      properties: { target: str('Canvas id or catalog type id') },
      required: ['target'],
    },
  },
  {
    name: 'add_board',
    description:
      'Add a microcontroller board to the canvas (e.g. arduino-uno, arduino-mega, ' +
      'raspberry-pi-pico, esp32). Returns the board id used for wiring and files.',
    input_schema: {
      type: 'object',
      properties: {
        board_kind: str('One of the supported board kinds, e.g. "arduino-uno"'),
        x: num('Canvas x position in px (default 50)'),
        y: num('Canvas y position in px (default 50)'),
      },
      required: ['board_kind'],
    },
  },
  {
    name: 'remove_board',
    description: 'Remove a board (and its code files) from the canvas.',
    input_schema: {
      type: 'object',
      properties: { board_id: str('Board id from the project state') },
      required: ['board_id'],
    },
  },
  {
    name: 'set_active_board',
    description:
      'Set which board is active. compile / run_simulation / write_file (without board_id) target the active board.',
    input_schema: {
      type: 'object',
      properties: { board_id: str('Board id') },
      required: ['board_id'],
    },
  },
  {
    name: 'set_board_language',
    description:
      'Switch a board between Arduino C++ ("arduino") and MicroPython ("micropython"). ' +
      'Only RP2040 (Pico) and ESP32 boards support MicroPython. Switching replaces the board file group.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['arduino', 'micropython'], description: 'Language mode' },
        board_id: str('Board id (default: active board)'),
      },
      required: ['mode'],
    },
  },
  {
    name: 'add_component',
    description:
      'Add an electronic component to the canvas. Use list_component_types to find the type id. ' +
      'Place components on a 20px grid, at least 120px apart, and to the right of / below the board ' +
      '(boards are roughly 300x220px). Returns the assigned component id.',
    input_schema: {
      type: 'object',
      properties: {
        type: str('Catalog type id, e.g. "led-red", "resistor", "hc-sr04"'),
        x: num('Canvas x in px'),
        y: num('Canvas y in px'),
        id: str('Optional explicit id (default: auto "<type>-<n>")'),
        properties: {
          type: 'object',
          description:
            'Optional component properties (e.g. {"value": "220"} for a resistor, {"color": "red"} for an LED). ' +
            'Available properties are listed by list_component_types.',
        },
      },
      required: ['type', 'x', 'y'],
    },
  },
  {
    name: 'update_component',
    description: 'Move a component or change its properties.',
    input_schema: {
      type: 'object',
      properties: {
        id: str('Component id'),
        x: num('New x'),
        y: num('New y'),
        properties: { type: 'object', description: 'Properties to merge into the component' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_component',
    description: 'Remove a component from the canvas (its wires are removed too).',
    input_schema: {
      type: 'object',
      properties: { id: str('Component id') },
      required: ['id'],
    },
  },
  {
    name: 'add_wire',
    description:
      'Connect two pins with a wire. Endpoints reference canvas ids (board or component) plus a pin ' +
      'name exactly as reported by get_pins. Every circuit needs complete power paths — do not forget ' +
      'GND and VCC/5V/3V3 connections. OMIT color to get the standard signal-type color automatically ' +
      '(power red, GND black, digital green, analog blue, PWM purple, I2C gold, SPI orange, UART cyan) ' +
      '— only pass color for a deliberate look, e.g. matching a yellow LED with a yellow wire.',
    input_schema: {
      type: 'object',
      properties: {
        start_component: str('Canvas id of the first endpoint (board or component id)'),
        start_pin: str('Pin name on the first endpoint, e.g. "13", "GND.1", "A", "VCC"'),
        end_component: str('Canvas id of the second endpoint'),
        end_pin: str('Pin name on the second endpoint'),
        color: str('Optional override (css name/hex). Omit for the standard signal-type color.'),
      },
      required: ['start_component', 'start_pin', 'end_component', 'end_pin'],
    },
  },
  {
    name: 'remove_wire',
    description: 'Remove a wire by id (ids are listed in the project state).',
    input_schema: {
      type: 'object',
      properties: { id: str('Wire id') },
      required: ['id'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or fully overwrite a code file in a board\'s workspace. The main Arduino file must be ' +
      'named "sketch.ino"; MicroPython uses "main.py". Prefer edit_file for small changes to an ' +
      'existing file so the student\'s other edits are preserved.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('File name, e.g. "sketch.ino"'),
        content: str('Full file content'),
        board_id: str('Board id (default: active board)'),
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact text fragment in an existing file. old_str must appear EXACTLY ONCE in the ' +
      'file (include surrounding lines to disambiguate). This is the preferred way to modify code the ' +
      'student may have edited.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('File name'),
        old_str: str('Exact existing text to replace (must be unique in the file)'),
        new_str: str('Replacement text'),
        board_id: str('Board id (default: active board)'),
      },
      required: ['name', 'old_str', 'new_str'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a code file from a board\'s workspace.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('File name'),
        board_id: str('Board id (default: active board)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'install_library',
    description:
      'Install an Arduino library by its registry name (e.g. "Adafruit SSD1306", "Servo", ' +
      '"DHT sensor library") and add it to the board\'s library manifest. Install every library your ' +
      'sketch #includes that is not built-in.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('Library name in the Arduino library registry'),
        board_id: str('Board id whose manifest to update (default: active board)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'compile',
    description:
      'Compile the ACTIVE board\'s code (same as the editor Compile button). Returns errors/warnings. ' +
      'ALWAYS compile after writing code and fix any errors before telling the user you are done.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_simulation',
    description:
      'Compile if needed and start the simulation for the active board (same as the Run button).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_simulation',
    description: 'Stop the running simulation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_serial',
    description:
      'Read the tail of a board\'s Serial Monitor output. Useful to verify behaviour after run_simulation.',
    input_schema: {
      type: 'object',
      properties: { board_id: str('Board id (default: active board)') },
    },
  },
  {
    name: 'observe_simulation',
    description:
      'Watch the running simulation for a time window and report what the components are ACTUALLY ' +
      'doing: LED on/off + toggle count (detects blinking and its frequency), servo angle sweep, ' +
      'buzzer on/off, 7-segment digit, LCD text, OLED pixel view, wired pin levels, burnt components, ' +
      'and serial output produced during the window. ALWAYS verify visible behaviour with this tool ' +
      'after run_simulation before reporting success. Note: ~100ms sampling cannot resolve fast PWM — ' +
      'for dimming, read the reported brightness (period-averaged) instead of toggle counts.',
    input_schema: {
      type: 'object',
      properties: {
        duration_ms: num(`Observation window in ms, 0-${MAX_OBSERVE_MS} (default 1500)`),
        component_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit the report to these component ids (default: all components)',
        },
      },
    },
  },
  {
    name: 'interact',
    description:
      'Act on an input component and observe the response — press/click buttons, set potentiometer/' +
      'switch values, or set sensor readings (e.g. DHT22 temperature) — then reports a before → after ' +
      'diff of all outputs. Use this to TEST input-driven requirements: click the button and confirm ' +
      'the LED toggles; set_sensor the temperature above the alarm threshold AND back below it.',
    input_schema: {
      type: 'object',
      properties: {
        component_id: str('Canvas id of the input component'),
        action: {
          type: 'string',
          enum: ['click', 'press', 'release', 'set_value', 'set_sensor'],
          description:
            'click = press+release (buttons); press/release = hold control; set_value = pot/switch ' +
            'value; set_sensor = sensor readings via values object',
        },
        value: num('For set_value: the numeric value (pot 0-1023, switch 0/1)'),
        values: {
          type: 'object',
          description:
            'For set_sensor: readings to apply, e.g. {"temperature": 35} for dht22, ' +
            '{"distance": 50} for hc-sr04, {"lux": 800} for photoresistor-sensor',
        },
        hold_ms: num('For click: how long to hold the press (default 300ms — beats debounce)'),
        observe_ms: num('Observation window after the action (default 800ms)'),
      },
      required: ['component_id', 'action'],
    },
  },
  {
    name: 'check_circuit',
    description:
      'Run the electrical pre-flight check on the current circuit (SPICE worst-case analysis). ' +
      'Catches missing GND/VCC connections, LEDs without series resistors, shorts, reverse polarity, ' +
      'and overcurrent BEFORE running. Call this after wiring, and fix every error before writing code.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_libraries',
    description:
      'Search the Arduino library registry for the exact installable name. Use when install_library ' +
      'fails or you are unsure of a library\'s registry name (e.g. DHT22 → "DHT sensor library").',
    input_schema: {
      type: 'object',
      properties: { query: str('Search term, e.g. "ssd1306", "dht", "servo"') },
      required: ['query'],
    },
  },
  {
    name: 'search_examples',
    description:
      'Search ~500 built-in example projects (exact components, pin-level wiring, libraries, working ' +
      'code). Call this BEFORE wiring any sensor/display you have not wired in this conversation — ' +
      'copying a reference beats guessing pins. Returns example ids for get_example.',
    input_schema: {
      type: 'object',
      properties: { query: str('Component or topic, e.g. "oled i2c", "servo potentiometer", "红绿灯"') },
      required: ['query'],
    },
  },
  {
    name: 'get_example',
    description:
      'Fetch one example project in full: components with properties, complete pin-level wiring, ' +
      'required library names, and code. Use the wiring as the authoritative reference.',
    input_schema: {
      type: 'object',
      properties: { id: str('Example id from search_examples') },
      required: ['id'],
    },
  },
  {
    name: 'save_version',
    description:
      'Save a named snapshot of the WHOLE project (boards, components, wires, all code) into the ' +
      'version history the user sees in the Versions panel. Do this before big or destructive ' +
      'changes, and whenever the user asks to save/mark a version. Versions survive page reloads.',
    input_schema: {
      type: 'object',
      properties: { label: str('Short human name for the version, e.g. "v1 交通灯完成"') },
      required: ['label'],
    },
  },
  {
    name: 'list_versions',
    description:
      'List the project version history (id, time, label, source). Use it when the user wants to ' +
      'roll back and you need to find the right version.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'restore_version',
    description:
      'Roll the WHOLE project back to a saved version. DESTRUCTIVE for current unsaved work — you ' +
      'MUST have asked the user and received an explicit yes in this conversation before calling ' +
      'this (a safety backup of the current state is taken automatically).',
    input_schema: {
      type: 'object',
      properties: { id: str('Version id from list_versions') },
      required: ['id'],
    },
  },
];

// ── Executor ───────────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;

/** Per-call context threaded from the agent loop (Pi-style tool interface). */
export interface ToolContext {
  toolCallId?: string;
  /** Abort signal of the run — long tools should stop early when it fires. */
  signal?: AbortSignal;
  /** Streaming progress for the running chip (compile log tail, …). */
  onUpdate?: (detail: string) => void;
}

async function execTool(name: string, input: ToolInput, ctx: ToolContext): Promise<string> {
  const sim = () => useSimulatorStore.getState();
  const editor = () => useEditorStore.getState();

  switch (name) {
    case 'get_project':
      return buildProjectSnapshot();

    case 'list_component_types': {
      await registry.loadPromise;
      const query = String(input.query ?? '').trim();
      const results = registry.search(query);
      if (results.length === 0) return `No component types match "${query}".`;
      const shown = results.slice(0, 25);
      const lines = shown.map((m) => {
        const props =
          m.properties && m.properties.length > 0
            ? ` props: ${m.properties.map((p) => p.name).join(', ')}`
            : '';
        return `- ${m.id} — ${m.name} [${m.category}, ${m.pinCount} pins]${props}\n  ${(m.description ?? '').slice(0, 140)}`;
      });
      const more = results.length > shown.length ? `\n(${results.length - shown.length} more — refine the query)` : '';
      return lines.join('\n') + more;
    }

    case 'get_pins': {
      const target = String(input.target ?? '');
      await settleDom();
      const pins = resolvePins(target);
      if (!pins) {
        throw new ToolError(
          `Cannot determine pins for "${target}". If it is a catalog type, add it to the canvas ` +
            `first and call get_pins with the canvas id.`,
        );
      }
      return pins
        .map((p) => `${p.name}${p.description ? ` — ${p.description}` : ''}`)
        .join('\n');
    }

    case 'add_board': {
      const kind = String(input.board_kind ?? '') as BoardKind;
      if (!(kind in BOARD_KIND_LABELS)) {
        throw new ToolError(
          `Unknown board kind "${kind}". Supported: ${Object.keys(BOARD_KIND_LABELS).join(', ')}`,
        );
      }
      const x = typeof input.x === 'number' ? input.x : 50;
      const y = typeof input.y === 'number' ? input.y : 50;
      const id = sim().addBoard(kind, x, y);
      sim().setActiveBoardId(id);
      await settleDom();
      return `Added board "${id}" (${kind}) at (${x}, ${y}); it is now the active board.`;
    }

    case 'remove_board': {
      const boardId = String(input.board_id ?? '');
      resolveBoard(boardId); // throws if missing
      sim().removeBoard(boardId);
      return `Removed board "${boardId}".`;
    }

    case 'set_active_board': {
      const board = resolveBoard(String(input.board_id ?? ''));
      sim().setActiveBoardId(board.id);
      return `Active board is now "${board.id}".`;
    }

    case 'set_board_language': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const mode = String(input.mode);
      if (mode !== 'arduino' && mode !== 'micropython') {
        throw new ToolError(`mode must be "arduino" or "micropython"`);
      }
      sim().setBoardLanguageMode(board.id, mode);
      return `Board "${board.id}" language mode set to ${mode}. Its file group was reset — write the code files now.`;
    }

    case 'add_component': {
      await registry.loadPromise;
      const type = String(input.type ?? '');
      const meta = registry.getById(type);
      if (!meta) {
        const near = registry
          .search(type)
          .slice(0, 5)
          .map((m) => m.id);
        throw new ToolError(
          `Unknown component type "${type}".` +
            (near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use list_component_types.'),
        );
      }
      const id = input.id ? String(input.id) : uniqueComponentId(type);
      if (
        sim().components.some((c) => c.id === id) ||
        sim().boards.some((b) => b.id === id)
      ) {
        throw new ToolError(`Id "${id}" is already used on the canvas.`);
      }
      const x = snap(Number(input.x));
      let y = snap(Number(input.y));
      const properties = {
        ...(meta.defaultValues ?? {}),
        ...((input.properties as Record<string, unknown>) ?? {}),
      };
      sim().addComponent({ id, metadataId: type, x, y, properties });
      await settleDom();

      // Size-aware collision safety net: the model can't know real element
      // footprints (an LCD1602 is ~205px wide). If the mounted element
      // overlaps something, step it down (keeping the chosen column) to the
      // first free spot and SAY so — the model learns the real size and
      // corrects its next placement itself.
      const size = measureEl(id);
      let bumpNote = '';
      if (size) {
        const others = occupiedRects(id);
        const originalY = y;
        let bumpedBy: string | null = null;
        for (let guard = 0; guard < 200; guard++) {
          const hit = others.find((r) => rectsOverlap({ id, x, y, ...size }, r));
          if (!hit) break;
          bumpedBy = hit.id;
          y += GRID;
        }
        if (y !== originalY) {
          sim().updateComponent(id, { y });
          await settleDom();
          safeRecalcWires();
          bumpNote = ` (moved down from y=${originalY} to avoid overlapping "${bumpedBy}")`;
        }
      }

      flashCanvasElement(id);
      const sizeNote = size ? ` — element is ${size.w}×${size.h}px` : '';
      return `Added ${type} as "${id}" at (${x}, ${y})${sizeNote}.${bumpNote}`;
    }

    case 'update_component': {
      const id = String(input.id ?? '');
      const existing = sim().components.find((c) => c.id === id);
      if (!existing) throw new ToolError(`Component "${id}" not found.`);
      const updates: Record<string, unknown> = {};
      if (typeof input.x === 'number') updates.x = input.x;
      if (typeof input.y === 'number') updates.y = input.y;
      if (input.properties && typeof input.properties === 'object') {
        updates.properties = { ...existing.properties, ...(input.properties as object) };
      }
      sim().updateComponent(id, updates);
      await settleDom();
      safeRecalcWires();
      return `Updated component "${id}".`;
    }

    case 'remove_component': {
      const id = String(input.id ?? '');
      if (!sim().components.some((c) => c.id === id)) {
        throw new ToolError(`Component "${id}" not found.`);
      }
      sim().removeComponent(id);
      return `Removed component "${id}" and its wires.`;
    }

    case 'add_wire': {
      const startComponent = String(input.start_component ?? '');
      const startPin = String(input.start_pin ?? '');
      const endComponent = String(input.end_component ?? '');
      const endPin = String(input.end_pin ?? '');

      const knownIds = new Set([
        ...sim().components.map((c) => c.id),
        ...sim().boards.map((b) => b.id),
      ]);
      for (const cid of [startComponent, endComponent]) {
        if (!knownIds.has(cid)) {
          throw new ToolError(
            `"${cid}" is not on the canvas. Canvas ids: ${[...knownIds].join(', ')}`,
          );
        }
      }

      await settleDom();
      const warnings: string[] = [];
      const endpointPins: (PinDescriptor[] | null)[] = [];
      for (const [cid, pin] of [
        [startComponent, startPin],
        [endComponent, endPin],
      ] as const) {
        const pins = resolvePins(cid);
        endpointPins.push(pins);
        if (pins && !pinExists(pins, pin)) {
          throw new ToolError(
            `Pin "${pin}" does not exist on "${cid}". Available pins: ${pins
              .map((p) => p.name)
              .join(', ')}`,
          );
        }
        if (!pins) warnings.push(`could not verify pin "${pin}" on "${cid}" (element not mounted)`);
      }

      // Standard color by signal type when the model doesn't pick one; the
      // classification is stored either way (feeds the electrical layer).
      const signalType = classifyWire(endpointPins[0], startPin, endpointPins[1], endPin);
      const explicitColor = input.color ? String(input.color) : null;
      const color = explicitColor ?? WIRE_COLORS[signalType];

      const id = uniqueWireId();
      const wire: Wire = {
        id,
        start: { componentId: startComponent, pinName: startPin, x: 0, y: 0 },
        end: { componentId: endComponent, pinName: endPin, x: 0, y: 0 },
        color,
        signalType,
        waypoints: [],
      };
      sim().addWire(wire);
      await settleDom();
      safeRecalcWires();
      return (
        `Added wire "${id}": ${startComponent}:${startPin} -> ${endComponent}:${endPin} ` +
        `(${explicitColor ?? `auto ${color}`}, classified as ${signalType}).` +
        (warnings.length ? ` Warning: ${warnings.join('; ')}.` : '')
      );
    }

    case 'remove_wire': {
      const id = String(input.id ?? '');
      if (!sim().wires.some((w) => w.id === id)) throw new ToolError(`Wire "${id}" not found.`);
      sim().removeWire(id);
      return `Removed wire "${id}".`;
    }

    case 'write_file': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const fname = String(input.name ?? '');
      const content = String(input.content ?? '');
      if (!fname) throw new ToolError('name is required');
      const existing = findGroupFile(board.activeFileGroupId, fname);
      if (existing) {
        lastDiff = lineDiff(existing.content, content);
        editor().updateGroupFile(board.activeFileGroupId, existing.id, content);
        return `Overwrote ${fname} (${content.length} chars) on board "${board.id}".`;
      }
      lastDiff = lineDiff('', content);
      editor().addFileToGroup(board.activeFileGroupId, fname, content);
      return `Created ${fname} (${content.length} chars) on board "${board.id}".`;
    }

    case 'edit_file': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const fname = String(input.name ?? '');
      const oldStr = String(input.old_str ?? '');
      const newStr = String(input.new_str ?? '');
      const file = findGroupFile(board.activeFileGroupId, fname);
      if (!file) {
        const names = editor()
          .getGroupFiles(board.activeFileGroupId)
          .map((f) => f.name)
          .join(', ');
        throw new ToolError(`File "${fname}" not found on board "${board.id}". Files: ${names}`);
      }
      if (!oldStr) throw new ToolError('old_str must not be empty');
      const count = file.content.split(oldStr).length - 1;
      if (count === 0) {
        throw new ToolError(
          `old_str not found in ${fname}. The student may have edited the file — call get_project ` +
            `to re-read the current content, then retry.`,
        );
      }
      if (count > 1) {
        throw new ToolError(
          `old_str appears ${count} times in ${fname}; include more surrounding context so it is unique.`,
        );
      }
      const newContent = file.content.replace(oldStr, newStr);
      lastDiff = lineDiff(file.content, newContent);
      editor().updateGroupFile(board.activeFileGroupId, file.id, newContent);
      return `Edited ${fname} on board "${board.id}".`;
    }

    case 'delete_file': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const fname = String(input.name ?? '');
      const file = findGroupFile(board.activeFileGroupId, fname);
      if (!file) throw new ToolError(`File "${fname}" not found on board "${board.id}".`);
      editor().deleteFileFromGroup(board.activeFileGroupId, file.id);
      return `Deleted ${fname} from board "${board.id}".`;
    }

    case 'install_library': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const libName = String(input.name ?? '');
      const result = await installLibrary(libName);
      if (!result.success) {
        // Wrong registry name is the #1 non-code failure — suggest close matches.
        let didYouMean = '';
        try {
          const near = (await searchLibraries(libName)).slice(0, 5).map((l) => `"${l.name}"`);
          if (near.length > 0) didYouMean = ` Did you mean: ${near.join(', ')}?`;
        } catch {
          /* suggestion is best-effort */
        }
        throw new ToolError(
          `Failed to install "${libName}": ${result.error ?? 'unknown error'}.${didYouMean}`,
        );
      }
      const libs = new Set(board.libraries ?? []);
      libs.add(libName);
      sim().updateBoard(board.id, { libraries: [...libs] });
      return `Installed library "${libName}" and added it to board "${board.id}"'s manifest.`;
    }

    case 'compile': {
      const actions = getToolbarActions();
      if (!actions) throw new ToolError('Editor toolbar not mounted — cannot compile right now.');
      // Capture this compile's log entries BY TIMESTAMP, not by array index:
      // handleCompile clears previous logs first, so an index-based slice can
      // come up empty and silently swallow errors.
      const startedAt = new Date(Date.now() - 1);
      // Stream the log tail into the running chip — ESP32 server-side builds
      // are slow and otherwise silent.
      const unsubProgress = ctx.onUpdate
        ? useCompileLogsStore.subscribe((s) => {
            const fresh = s.logs.filter((l) => l.timestamp >= startedAt);
            if (fresh.length > 0) {
              ctx.onUpdate!(tail(fresh.map((l) => l.message).join('\n'), 800));
            }
          })
        : null;
      try {
        await actions.compile();
      } finally {
        unsubProgress?.();
      }
      if (ctx.signal?.aborted) return 'Compile finished, but the run was aborted by the user.';
      const logs = useCompileLogsStore.getState().logs.filter((l) => l.timestamp >= startedAt);
      const errors = logs.filter((l) => l.type === 'error').map((l) => l.message);
      const warnings = logs.filter((l) => l.type === 'warning').map((l) => l.message);
      if (errors.length > 0) {
        const errorBlob = errors.join('\n');
        const hints = compileErrorHints(errorBlob);
        return (
          `COMPILE FAILED with ${errors.length} error line(s):\n` +
          tail(errorBlob, 4000) +
          (warnings.length ? `\nWarnings:\n${tail(warnings.join('\n'), 1000)}` : '') +
          (hints.length ? `\nHints:\n${hints.map((h) => `- ${h}`).join('\n')}` : '') +
          `\nFix the code and compile again.`
        );
      }
      return (
        'Compile succeeded.' +
        (warnings.length ? ` Warnings:\n${tail(warnings.join('\n'), 1500)}` : '')
      );
    }

    case 'run_simulation': {
      const actions = getToolbarActions();
      if (!actions) throw new ToolError('Editor toolbar not mounted — cannot run right now.');
      // Timestamp capture — see the `compile` case for why index slicing is wrong.
      const startedAt = new Date(Date.now() - 1);
      const unsubProgress = ctx.onUpdate
        ? useCompileLogsStore.subscribe((s) => {
            const fresh = s.logs.filter((l) => l.timestamp >= startedAt);
            if (fresh.length > 0) {
              ctx.onUpdate!(tail(fresh.map((l) => l.message).join('\n'), 800));
            }
          })
        : null;
      try {
        await actions.run();
      } finally {
        unsubProgress?.();
      }
      const logs = useCompileLogsStore.getState().logs.filter((l) => l.timestamp >= startedAt);
      const errors = logs.filter((l) => l.type === 'error').map((l) => l.message);
      const board = sim().boards.find((b) => b.id === sim().activeBoardId);
      if (errors.length > 0) {
        return `Run failed:\n${tail(errors.join('\n'), 4000)}`;
      }
      return board?.running
        ? `Simulation is running on board "${board.id}". Use read_serial to inspect output.`
        : 'Run command issued. If the simulation did not start, compile first and check for errors.';
    }

    case 'stop_simulation': {
      const actions = getToolbarActions();
      if (!actions) throw new ToolError('Editor toolbar not mounted.');
      actions.stop();
      return 'Simulation stopped.';
    }

    case 'read_serial': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const out = board.serialOutput ?? '';
      if (!out) return `(no serial output on board "${board.id}" yet)`;
      return tail(out, 3000);
    }

    case 'observe_simulation': {
      const durationMs = typeof input.duration_ms === 'number' ? input.duration_ms : undefined;
      const componentIds = Array.isArray(input.component_ids)
        ? input.component_ids.map(String)
        : undefined;
      return observeSimulation({ durationMs, componentIds });
    }

    case 'interact': {
      return interact({
        componentId: String(input.component_id ?? ''),
        action: String(input.action ?? '') as InteractAction,
        value: typeof input.value === 'number' ? input.value : undefined,
        values:
          input.values && typeof input.values === 'object'
            ? (input.values as Record<string, number | boolean>)
            : undefined,
        holdMs: typeof input.hold_ms === 'number' ? input.hold_ms : undefined,
        observeMs: typeof input.observe_ms === 'number' ? input.observe_ms : undefined,
      });
    }

    case 'check_circuit': {
      const result = await verifyCircuitFromStore();
      if (!result) {
        return (
          'Pre-flight check has nothing to analyse yet (no board or power source on the canvas), ' +
          'or the solver could not run. Not a failure — continue, and verify behaviour after running.'
        );
      }
      const fmtIssue = (i: { code: string; componentId?: string; message: string }) =>
        `- [${i.code}]${i.componentId ? ` ${i.componentId}:` : ''} ${i.message}`;
      if (result.errors.length === 0 && result.warnings.length === 0) {
        return `Circuit passes pre-flight checks (${result.componentsChecked} components inspected).`;
      }
      const parts: string[] = [];
      if (result.errors.length > 0) {
        parts.push(
          `CIRCUIT ERRORS (fix these before running — they will burn parts or not work):\n` +
            result.errors.map(fmtIssue).join('\n'),
        );
      }
      if (result.warnings.length > 0) {
        parts.push(`Warnings:\n${result.warnings.map(fmtIssue).join('\n')}`);
      }
      return parts.join('\n');
    }

    case 'search_libraries': {
      const query = String(input.query ?? '').trim();
      if (!query) throw new ToolError('query is required');
      const libs = await searchLibraries(query);
      if (libs.length === 0) return `No libraries match "${query}".`;
      return libs
        .slice(0, 8)
        .map((l) => {
          const sentence = l.sentence ?? l.latest?.sentence ?? '';
          const version = l.version ?? l.latest?.version ?? '';
          return `- "${l.name}"${version ? ` (${version})` : ''}${sentence ? ` — ${sentence.slice(0, 100)}` : ''}`;
        })
        .join('\n');
    }

    case 'search_examples':
      return searchExamplesText(String(input.query ?? ''));

    case 'get_example':
      return getExampleText(String(input.id ?? ''));

    case 'save_version': {
      const label = String(input.label ?? '').trim();
      if (!label) throw new ToolError('label is required');
      const meta = await useVersionStore.getState().saveVersion(label, 'ai');
      if (!meta) {
        return 'No version saved — the project is identical to the newest existing version.';
      }
      return `Saved version "${meta.label}" (id ${meta.id}).`;
    }

    case 'list_versions': {
      const store = useVersionStore.getState();
      if (!store.loaded) await store.refresh();
      const versions = useVersionStore.getState().versions;
      if (versions.length === 0) return 'No versions saved yet. Use save_version to create one.';
      return versions
        .slice(0, 20)
        .map((v) => {
          const when = new Date(v.createdAt).toLocaleString();
          return `- ${v.id} [${v.source}] "${v.label}" — ${when} (${v.stats.boards} boards, ${v.stats.components} parts, ${v.stats.files} files)`;
        })
        .join('\n');
    }

    case 'restore_version': {
      const id = String(input.id ?? '');
      if (!id) throw new ToolError('id is required — find it with list_versions');
      const ok = await useVersionStore.getState().restoreVersion(id);
      if (!ok) {
        throw new ToolError(
          `Could not restore "${id}" — check the id with list_versions (another restore may be in progress).`,
        );
      }
      return `Project restored to version "${id}". A safety backup of the previous state was saved automatically.`;
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

export interface ToolExecution {
  result: string;
  isError: boolean;
  /** Line diff produced by write_file / edit_file — for the UI diff card */
  diff?: string;
}

/** Set by the file-writing cases during execTool; collected by executeTool. */
let lastDiff: string | undefined;

/** Execute a tool call; never throws — errors become is_error tool results. */
export async function executeTool(
  name: string,
  input: ToolInput,
  ctx: ToolContext = {},
): Promise<ToolExecution> {
  lastDiff = undefined;
  try {
    if (ctx.signal?.aborted) {
      return { result: 'ERROR: Aborted by user before this tool executed.', isError: true };
    }
    const result = await execTool(name, input, ctx);
    return { result, isError: false, diff: lastDiff || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: `ERROR: ${message}`, isError: true };
  }
}

/** zh / en verb per tool — the chat chip prefixes this to the argument. */
const TOOL_VERBS: Record<string, { zh: string; en: string }> = {
  get_project: { zh: '读取项目状态', en: 'Read project state' },
  list_component_types: { zh: '搜索元件', en: 'Search parts' },
  get_pins: { zh: '查看引脚', en: 'Inspect pins' },
  add_board: { zh: '添加开发板', en: 'Add board' },
  remove_board: { zh: '移除开发板', en: 'Remove board' },
  set_active_board: { zh: '切换开发板', en: 'Switch board' },
  set_board_language: { zh: '切换语言', en: 'Switch language' },
  add_component: { zh: '添加元件', en: 'Add part' },
  update_component: { zh: '更新元件', en: 'Update part' },
  remove_component: { zh: '移除元件', en: 'Remove part' },
  add_wire: { zh: '接线', en: 'Wire' },
  remove_wire: { zh: '移除导线', en: 'Remove wire' },
  write_file: { zh: '写入文件', en: 'Write file' },
  edit_file: { zh: '编辑文件', en: 'Edit file' },
  delete_file: { zh: '删除文件', en: 'Delete file' },
  install_library: { zh: '安装库', en: 'Install library' },
  compile: { zh: '编译', en: 'Compile' },
  run_simulation: { zh: '运行仿真', en: 'Run simulation' },
  stop_simulation: { zh: '停止仿真', en: 'Stop simulation' },
  read_serial: { zh: '读取串口输出', en: 'Read serial output' },
  observe_simulation: { zh: '观察仿真状态', en: 'Observe simulation' },
  interact: { zh: '操作元件', en: 'Interact' },
  check_circuit: { zh: '检查电路', en: 'Check circuit' },
  search_libraries: { zh: '搜索库', en: 'Search libraries' },
  search_examples: { zh: '搜索示例', en: 'Search examples' },
  get_example: { zh: '读取示例', en: 'Load example' },
  save_version: { zh: '保存版本', en: 'Save version' },
  list_versions: { zh: '列出版本', en: 'List versions' },
  restore_version: { zh: '恢复版本', en: 'Restore version' },
};

/** Argument summary appended to the verb (language-neutral values). */
function toolArg(name: string, input: ToolInput): string {
  switch (name) {
    case 'list_component_types':
      return String(input.query ?? '');
    case 'get_pins':
      return String(input.target ?? '');
    case 'add_board':
      return String(input.board_kind ?? '');
    case 'remove_board':
    case 'set_active_board':
      return String(input.board_id ?? '');
    case 'set_board_language':
      return String(input.mode ?? '');
    case 'add_component':
      return String(input.type ?? '');
    case 'update_component':
    case 'remove_component':
    case 'remove_wire':
      return String(input.id ?? '');
    case 'add_wire':
      return `${input.start_component}:${input.start_pin} → ${input.end_component}:${input.end_pin}`;
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'install_library':
      return String(input.name ?? '');
    case 'interact': {
      const action = String(input.action ?? '');
      const detail =
        action === 'set_sensor' && input.values
          ? ` ${JSON.stringify(input.values)}`
          : action === 'set_value' && input.value !== undefined
            ? ` ${input.value}`
            : '';
      return `${input.component_id} ${action}${detail}`;
    }
    case 'search_libraries':
    case 'search_examples':
      return String(input.query ?? '');
    case 'get_example':
    case 'restore_version':
      return String(input.id ?? '');
    case 'save_version':
      return String(input.label ?? '');
    default:
      return '';
  }
}

/** Follows the app's active locale (zh-* → Chinese, otherwise English). */
function uiLang(): 'zh' | 'en' {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang || '';
    if (lang.toLowerCase().startsWith('zh')) return 'zh';
    if (lang) return 'en';
  }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

/** Short human-readable label for the tool-call chip in the chat UI. */
export function toolLabel(name: string, input: ToolInput): string {
  const verb = TOOL_VERBS[name]?.[uiLang()] ?? name;
  const arg = toolArg(name, input);
  return arg ? `${verb}: ${arg}` : verb;
}
