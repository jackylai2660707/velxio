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
import { breadboardHoles, resolveSeatPosition, seatOnDrop, validateTactileButtonSeating } from '../utils/breadboardSnap';
import { breadboardGroupKey, isBreadboard } from '../utils/breadboardNets';
import { holeIsOccupied, resolveFreeHole } from '../utils/breadboardOccupancy';
import type { ToolDefinition } from './types';
import { formatCodeWiringLint, lintCodeWiring } from './codeWiringLint';
import { formatPinContract, resolvePinContract, validatePinUse } from './boardPinContract';
import { analyzeHardwareSafety } from './hardwareSafety';

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

/** Custom elements can upgrade a little after React mounts them. Wait briefly
 * for pinInfo before seating instead of returning a deterministic geometry
 * error that forces the model into another turn. */
async function waitForMountedPins(id: string, timeoutMs = 2200): Promise<PinDescriptor[] | null> {
  if (typeof document === 'undefined') return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pins = resolvePins(id);
    if (pins && pins.length > 0) return pins;
    if (Date.now() >= deadline) return null;
    await settleDom();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
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

/**
 * Breadboard endpoints are physical holes, not ordinary component pins.
 * Keep the agent path strict even though the canvas UI can move a manually
 * drawn endpoint to a neighbouring hole: an AI retry must never silently
 * stack another cable on a hole or draw a jumper across an already connected
 * terminal strip.  Invisible seating wires count as occupancy too.
 *
 * Duplicate detection intentionally happens before this guard in add_wire so
 * replaying an already accepted call remains idempotent.
 */
function validateBreadboardWireEndpoints(
  startComponent: string,
  startPin: string,
  endComponent: string,
  endPin: string,
): void {
  const state = useSimulatorStore.getState();
  const components = new Map(state.components.map((component) => [component.id, component]));
  const endpoints = [
    { componentId: startComponent, pinName: startPin },
    { componentId: endComponent, pinName: endPin },
  ];

  for (const endpoint of endpoints) {
    const component = components.get(endpoint.componentId);
    if (!component || !isBreadboard(component.metadataId)) continue;
    // Ignore malformed names here. The normal pin resolver below owns the
    // canonical "unknown pin" error and remains fail-closed in the browser.
    if (!breadboardGroupKey(component.metadataId, endpoint.pinName)) continue;
    if (holeIsOccupied(state.wires, endpoint.componentId, endpoint.pinName)) {
      throw new ToolError(
        `Breadboard hole ${endpoint.componentId}:${endpoint.pinName} is already occupied. ` +
          'The whole strip/rail is electrically shared: use a DIFFERENT FREE sibling hole in the same group (for example 10t.c → 10t.d), not the occupied hole. Do not wire directly to a seated component leg.',
      );
    }
  }

  // Every terminal-strip column and power rail is internally connected. A
  // visible jumper between two holes in one group is therefore a direct
  // same-net short and adds no useful connection. Reject it before mutating
  // the store, including the reverse endpoint order.
  if (startComponent === endComponent) {
    const component = components.get(startComponent);
    if (component && isBreadboard(component.metadataId) && startPin !== endPin) {
      const startGroup = breadboardGroupKey(component.metadataId, startPin);
      const endGroup = breadboardGroupKey(component.metadataId, endPin);
      if (startGroup && startGroup === endGroup) {
        throw new ToolError(
          `Breadboard holes ${startComponent}:${startPin} and ${endComponent}:${endPin} ` +
            `are already internally connected (${startGroup}); a visible wire would create a same-group short.`,
        );
      }
    }
  }
}

/** Shift an occupied breadboard endpoint to the nearest free sibling hole.
 * The group is one electrical node, so this preserves intent and avoids an
 * unnecessary failed LLM round-trip. Non-breadboard endpoints pass through. */
function resolveAgentBreadboardHole(componentId: string, pinName: string): string {
  const state = useSimulatorStore.getState();
  const component = state.components.find((candidate) => candidate.id === componentId);
  if (!component || !isBreadboard(component.metadataId)) return pinName;
  const allPins = breadboardHoles(component.metadataId)?.map((hole) => hole.name) ?? [];
  return resolveFreeHole(component.metadataId, componentId, pinName, state.wires, allPins);
}

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

const GRID = 20;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Add-component placement search limits.  A model often emits the same
 * coordinate for a resistor and its LED; searching a whole row first keeps
 * those series parts side-by-side and readable instead of stacking them in a
 * vertical pile.  The vertical limit matches the old downward bump guard,
 * while the horizontal limit is wide enough to clear an Uno/ESP32 footprint
 * plus a few neighbouring parts without allowing an unbounded search.
 */
const PLACEMENT_HORIZONTAL_STEPS = 24;
const PLACEMENT_VERTICAL_STEPS = 200;

/** Deterministic left/right offsets around a requested grid column. */
function horizontalPlacementOffsets(): number[] {
  const offsets = [0];
  for (let step = 1; step <= PLACEMENT_HORIZONTAL_STEPS; step++) {
    offsets.push(step * GRID, -step * GRID);
  }
  return offsets;
}

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
      'Switch a board between Arduino C++ ("arduino"), MicroPython ("micropython"), and pure ESP-IDF C/C++ ("espidf"). ' +
      'Only RP2040 (Pico) and ESP32 boards support MicroPython; pure ESP-IDF is available on supported ESP32 boards. ' +
      'Switching replaces the board file group. ESP-IDF projects use app_main() and ESP-IDF APIs (without Arduino).',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['arduino', 'micropython', 'espidf'],
          description: 'Language mode: arduino, micropython, or pure espidf',
        },
        board_id: str('Board id (default: active board)'),
      },
      required: ['mode'],
    },
  },
  {
    name: 'add_component',
    description:
      'Add an electronic component to the canvas. Use list_component_types to find the type id. ' +
      'Place components on a 20px grid, to the right of / below the board (boards are roughly 300x220px). ' +
      'For free-floating parts keep clear spacing; on a breadboard, use separate channel bands and let ' +
      'seat_component align the legs to exact holes. The placement safety net preserves a clear requested ' +
      'position, then searches free horizontal grid columns before moving down, so series parts such as an ' +
      'LED and resistor stay side-by-side instead of stacking. Returns the assigned component id.',
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
      'name exactly as reported by get_pins. Breadboard external wires must use a different free sibling hole in the same strip or rail, never an occupied leg hole. Every circuit needs complete power paths — do not forget ' +
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
    name: 'inspect_breadboard',
    description: 'Inspect breadboard occupancy, electrical strips, and FREE holes before wiring. Read-only; call once with include_free=true, then use only the returned exact hole names (never invent t/b bank or column names).',
    input_schema: {
      type: 'object',
      properties: { breadboard_id: str('Breadboard component id'), include_free: { type: 'boolean' }, limit: { type: 'number' } },
      required: ['breadboard_id'],
    },
  },
  {
    name: 'seat_component',
    description: 'Seat a component on the requested breadboard hole. Use inspect_breadboard first and choose an intentional free strip; the anchor is kept stable. The tool accepts only a FULL seating (every pin→hole) and rolls back partial/occupied placements. After success, connect external wires to a different free sibling hole in that same strip/rail, never to the component leg.',
    input_schema: { type: 'object', properties: { component_id: str('Component id'), breadboard_id: str('Breadboard id'), anchor_pin: str('Component pin'), anchor_hole: str('Exact hole such as 10t.a') }, required: ['component_id', 'breadboard_id', 'anchor_pin', 'anchor_hole'] },
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
      'Compile if needed and start the simulation for the active board (same as the Run button). If it is already running, return its status without restarting it.',
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
    name: 'check_hardware_safety',
    description:
      'Run a deterministic real-hardware safety audit on the current graph. Checks ESP32 3.3V-only GPIOs, ' +
      '5V level-shifting hazards, multiple MCU outputs on one net, direct motor/servo/relay GPIO power, ' +
      'HC-SR04 Echo level shifting, UART direction hints, and missing common ground. Read-only; run before ' +
      'compile/run together with check_circuit and lint_code_wiring.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lint_code_wiring',
    description:
      'Read-only code↔wiring consistency check for the selected board. Parses common Arduino/ESP32 ' +
      'calls (Wire.begin, SPI.begin/CS, Servo.attach, analogRead, digitalRead/digitalWrite/pinMode, ' +
      'DHT constructors and MicroPython I2C) and verifies each resolved pin reaches a canvas part, ' +
      'including through breadboard seating wires. Reports unresolved constants and likely SDA/SCL or ' +
      'SPI role swaps. Run after writing code and wiring, before compile/run; this complements check_circuit ' +
      'and never mutates the project.',
    input_schema: {
      type: 'object',
      properties: {
        board_id: str('Board id (default: active board)'),
      },
    },
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
  /** Per-run mutation memory used to stop remove→re-add oscillation. */
  turnMemory?: {
    removedWireFingerprints: Set<string>;
    createdWireIds?: Set<string>;
    /** Incremented by AgentRunner after code/wiring changes; used to decide
     * whether an already-running board needs a fresh run. */
    mutationEpoch?: number;
    runEpoch?: number;
  };
}

function wireTopologyFingerprint(startComponent: string, startPin: string, endComponent: string, endPin: string): string {
  return [`${startComponent}\u0000${startPin}`, `${endComponent}\u0000${endPin}`].sort().join('\u0001');
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
      // A rendered pin name alone cannot tell the agent that ESP32 GPIO34 is
      // input-only, GPIO6 is flash-reserved, or an Arduino rail is 5V. Add
      // the board contract beside each live pin so code/wiring decisions use
      // deterministic hardware facts rather than model memory. Components
      // have no board contract and keep their existing compact output.
      const boardInstance = sim().boards.find((board) => board.id === target);
      const boardKind =
        boardInstance?.boardKind ??
        (Object.prototype.hasOwnProperty.call(BOARD_KIND_LABELS, target) ? target : undefined);
      return pins
        .map((p) => {
          const contract = boardKind ? resolvePinContract(boardKind, p.name) : null;
          const contractText = contract ? `; ${formatPinContract(contract)}` : '';
          return `${p.name}${p.description ? ` — ${p.description}` : ''}${contractText}`;
        })
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
      if (mode !== 'arduino' && mode !== 'micropython' && mode !== 'espidf') {
        throw new ToolError(`mode must be "arduino", "micropython", or "espidf"`);
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
      const requestedX = snap(Number(input.x));
      const requestedY = snap(Number(input.y));
      let x = requestedX;
      let y = requestedY;
      const properties = {
        ...(meta.defaultValues ?? {}),
        ...((input.properties as Record<string, unknown>) ?? {}),
      };
      // Match the canvas drag path: axial resistors are vertical by default
      // so their leads bridge breadboard rows cleanly instead of lying across
      // adjacent channels. An explicit model/user rotation still wins.
      if ((type.startsWith('resistor') || type === 'wokwi-resistor') && properties.rotation === undefined) {
        properties.rotation = 90;
      }
      sim().addComponent({ id, metadataId: type, x, y, properties });
      await settleDom();

      // Size-aware collision safety net: the model can't know real element
      // footprints (an LCD1602 is ~205px wide). If the mounted element
      // overlaps something, search free grid columns on the same row before
      // moving down and SAY so — the model learns the real size and corrects
      // its next placement itself.
      const size = measureEl(id);
      let bumpNote = '';
      if (size) {
        const others = occupiedRects(id);
        const offsets = horizontalPlacementOffsets();
        const hitAt = (cx: number, cy: number) =>
          others.find((r) => rectsOverlap({ id, x: cx, y: cy, ...size }, r));

        // Search each row left/right around the requested column.  This is
        // intentionally row-major: a free neighbouring column wins over a
        // downward bump, keeping an LED/resistor pair readable in one row.
        let placed: { x: number; y: number } | null = null;
        let bumpedBy: string | null = null;
        for (let row = 0; row <= PLACEMENT_VERTICAL_STEPS && !placed; row++) {
          const cy = requestedY + row * GRID;
          for (const dx of offsets) {
            const cx = requestedX + dx;
            const hit = hitAt(cx, cy);
            if (!hit) {
              placed = { x: cx, y: cy };
              break;
            }
            // Preserve useful diagnostics for the eventual note when every
            // candidate is occupied (the final position then remains as
            // requested, matching the old bounded-search behaviour).
            bumpedBy ??= hit.id;
          }
        }

        if (placed) {
          x = placed.x;
          y = placed.y;
        }
        if (x !== requestedX || y !== requestedY) {
          sim().updateComponent(id, { x, y });
          await settleDom();
          safeRecalcWires();
          bumpNote = ` (moved from (${requestedX}, ${requestedY}) to (${x}, ${y}) to avoid overlapping "${bumpedBy ?? 'another component'}")`;
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
      let startPin = String(input.start_pin ?? '');
      const endComponent = String(input.end_component ?? '');
      let endPin = String(input.end_pin ?? '');

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

      if (startComponent === endComponent && startPin === endPin) {
        throw new ToolError(`Cannot connect a pin to itself: ${startComponent}:${startPin}.`);
      }
      const endpointKey = (component: string, pin: string) => `${component}\u0000${pin}`;
      const requested = [endpointKey(startComponent, startPin), endpointKey(endComponent, endPin)].sort().join('\u0001');
      const duplicate = sim().wires.find((w) => {
        if (w.bb) return false;
        const existing = [endpointKey(w.start.componentId, w.start.pinName), endpointKey(w.end.componentId, w.end.pinName)].sort().join('\u0001');
        return existing === requested;
      });
      if (duplicate) {
        return `Wire already exists (${duplicate.id}); no duplicate wire created.`;
      }

      // Agent often targets the exact hole occupied by a seated leg. Resolve
      // that request locally to a free sibling in the same strip/rail rather
      // than wasting another model call on a deterministic correction.
      startPin = resolveAgentBreadboardHole(startComponent, startPin);
      endPin = resolveAgentBreadboardHole(endComponent, endPin);
      const topology = wireTopologyFingerprint(startComponent, startPin, endComponent, endPin);
      if (ctx.turnMemory?.removedWireFingerprints.has(topology)) {
        throw new ToolError(
          'This exact wire topology was removed earlier in the same turn. Do not re-add it; keep the corrected layout and continue to the next requirement.',
        );
      }
      const resolvedRequest = [endpointKey(startComponent, startPin), endpointKey(endComponent, endPin)].sort().join('\u0001');
      const resolvedDuplicate = sim().wires.find((wire) => {
        if (wire.bb) return false;
        const existing = [endpointKey(wire.start.componentId, wire.start.pinName), endpointKey(wire.end.componentId, wire.end.pinName)].sort().join('\u0001');
        return existing === resolvedRequest;
      });
      if (resolvedDuplicate) {
        return `Wire already exists (${resolvedDuplicate.id}); no duplicate wire created.`;
      }
      // A seated-leg request can resolve to a different free sibling on each
      // retry (1t.a → 1t.b, then 1t.c). Compare breadboard endpoints by their
      // internal strip/rail group as well as exact names, so replaying the
      // original request remains idempotent instead of creating parallel
      // wires on the same electrical node.
      const endpointEquivalent = (a: { componentId: string; pinName: string }, b: { componentId: string; pinName: string }) => {
        if (a.componentId !== b.componentId) return false;
        if (a.pinName === b.pinName) return true;
        const component = sim().components.find((candidate) => candidate.id === a.componentId);
        if (!component || !isBreadboard(component.metadataId)) return false;
        const ga = breadboardGroupKey(component.metadataId, a.pinName);
        const gb = breadboardGroupKey(component.metadataId, b.pinName);
        return !!ga && ga === gb;
      };
      const semanticDuplicate = sim().wires.find((wire) => {
        if (wire.bb) return false;
        const direct = endpointEquivalent(wire.start, { componentId: startComponent, pinName: startPin }) &&
          endpointEquivalent(wire.end, { componentId: endComponent, pinName: endPin });
        const reverse = endpointEquivalent(wire.start, { componentId: endComponent, pinName: endPin }) &&
          endpointEquivalent(wire.end, { componentId: startComponent, pinName: startPin });
        return direct || reverse;
      });
      if (semanticDuplicate) {
        return `Wire already exists on the same breadboard node (${semanticDuplicate.id}); no duplicate wire created.`;
      }

      // A component seated on a breadboard already has invisible seating
      // wires from each leg to its hole. Adding another visible wire from the
      // same leg creates the classic AI-generated spaghetti: duplicate paths,
      // crossed jumpers, and electrically confusing diagrams. Route external
      // connections from the breadboard hole instead; the hole's internal
      // strip/rail provides the connection to the seated leg.
      for (const [cid, pin] of [[startComponent, startPin], [endComponent, endPin]] as const) {
        const seated = sim().wires.some((w) => w.bb && (
          (w.start.componentId === cid && w.start.pinName === pin) ||
          (w.end.componentId === cid && w.end.pinName === pin)
        ));
        if (seated) {
          throw new ToolError(
            `Pin ${cid}:${pin} is seated on a breadboard. Connect the breadboard hole/rail instead of the component leg to keep wiring clear.`,
          );
        }
      }

      // Unlike a hand-drawn UI wire (which can be shifted to a neighbouring
      // hole), an agent mutation must be deterministic. Reject occupied
      // breadboard holes and direct jumpers within one internally-connected
      // strip/rail before any store mutation. Duplicate replay was handled
      // above and seated component legs were handled immediately above.
      validateBreadboardWireEndpoints(startComponent, startPin, endComponent, endPin);

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
        const board = sim().boards.find((candidate) => candidate.id === cid);
        // Apply the conservative contract when this board family has one.
        // Unknown overlay boards keep the existing DOM pin validation path;
        // silently inventing a contract for them would be less safe.
        if (board) {
          const contract = resolvePinContract(board.boardKind, pin);
          if (contract) {
            const validation = validatePinUse(board.boardKind, pin, 'wire');
            if (!validation.ok) {
              throw new ToolError(`Unsafe board pin ${cid}:${pin}: ${validation.errors.join(' ')}`);
            }
            warnings.push(...validation.warnings);
          }
        }
        if (!pins && typeof document !== 'undefined') {
          throw new ToolError(`Cannot verify pin "${pin}" on "${cid}". Wait for the component to mount, call get_pins, then retry.`);
        }
      }

      // A direct board-rail → board-GPIO jumper is never a valid signal path:
      // it permanently drives the GPIO at the rail voltage (often 5 V on
      // mixed-board projects). Reject it before the store mutation; connecting
      // a board rail to a component VCC remains valid and is handled by the
      // circuit/hardware audits.
      const endpointBoards = [
        { board: sim().boards.find((candidate) => candidate.id === startComponent), pin: startPin, id: startComponent },
        { board: sim().boards.find((candidate) => candidate.id === endComponent), pin: endPin, id: endComponent },
      ];
      if (endpointBoards[0].board && endpointBoards[1].board) {
        const aContract = resolvePinContract(endpointBoards[0].board.boardKind, endpointBoards[0].pin);
        const bContract = resolvePinContract(endpointBoards[1].board.boardKind, endpointBoards[1].pin);
        const aPower = aContract?.powerRole && aContract.powerRole !== 'gnd';
        const bPower = bContract?.powerRole && bContract.powerRole !== 'gnd';
        // Input-only pads are still GPIO pads: a rail connected to GPIO34/36
        // is a hard voltage injection and can damage the ESP32 even though
        // firmware cannot drive that pad.  Keep them in the over-voltage
        // guard; the separate contract check handles output capability.
        const aGpio = aContract?.gpio !== undefined;
        const bGpio = bContract?.gpio !== undefined;
        if ((aPower && bGpio) || (bPower && aGpio)) {
          throw new ToolError('Unsafe direct power-rail to GPIO connection. Route signals from a GPIO and power loads from a compatible supply; do not hard-drive a GPIO from 3.3V/5V.');
        }
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
        autoRouted: true,
      };
      sim().addWire(wire);
      ctx.turnMemory?.createdWireIds?.add(id);
      await settleDom();
      safeRecalcWires();
      return (
        `Added wire "${id}": ${startComponent}:${startPin} -> ${endComponent}:${endPin} ` +
        `(${explicitColor ?? `auto ${color}`}, classified as ${signalType}).` +
        (warnings.length ? ` Warning: ${warnings.join('; ')}.` : '')
      );
    }

    case 'inspect_breadboard': {
      const id = String(input.breadboard_id ?? '');
      const board = sim().components.find((c) => c.id === id && (c.metadataId === 'breadboard' || c.metadataId === 'breadboard-mini'));
      if (!board) throw new ToolError(`Breadboard "${id}" not found.`);
      const limit = Math.max(1, Math.min(100, Number(input.limit) || 30));
      const includeFree = input.include_free === true;
      const used = sim().wires.flatMap((w) => {
        const out: string[] = [];
        if (w.start.componentId === id) out.push(w.start.pinName);
        if (w.end.componentId === id) out.push(w.end.pinName);
        return out;
      });
      const groups = [...new Set(used.map((hole) => breadboardGroupKey(board.metadataId, hole)).filter(Boolean))];
      const visibleWires = sim().wires.filter((w) => !w.bb && (w.start.componentId === id || w.end.componentId === id)).map((w) => w.id);
      const seatingWires = sim().wires.filter((w) => w.bb && (w.start.componentId === id || w.end.componentId === id)).map((w) => w.id);
      const holes = breadboardHoles(board.metadataId) ?? [];
      const occupied = new Set(used);
      const free = holes.filter((hole) => !occupied.has(hole.name));
      const freeByGroup = new Map<string, string[]>();
      if (includeFree) {
        for (const hole of free) {
          const group = breadboardGroupKey(board.metadataId, hole.name);
          if (!group) continue;
          const list = freeByGroup.get(group) ?? [];
          if (list.length < 5) list.push(hole.name);
          freeByGroup.set(group, list);
          if (freeByGroup.size >= limit && list.length >= 5) break;
        }
      }
      const report: Record<string, unknown> = {
        breadboard_id: id,
        type: board.metadataId,
        occupied_holes: used.slice(0, limit),
        occupied_groups: groups.slice(0, limit),
        visible_wires: visibleWires.slice(0, limit),
        seating_wires: seatingWires.slice(0, limit),
        truncated: used.length > limit || groups.length > limit || visibleWires.length > limit || seatingWires.length > limit,
        note: 'Seating wires are invisible internal leg-to-hole connections; connect external wires to holes/rails, not seated component legs. A listed group is one electrical node; choose a different FREE hole in that group for each external wire.',
      };
      if (includeFree) {
        report.free_holes = free.slice(0, limit).map((hole) => hole.name);
        report.free_by_group = Object.fromEntries([...freeByGroup.entries()].slice(0, limit));
        report.free_holes_truncated = free.length > limit;
      }
      return JSON.stringify(report);
    }

    case 'seat_component': {
      const cid = String(input.component_id ?? ''), bid = String(input.breadboard_id ?? ''), pin = String(input.anchor_pin ?? ''), hole = String(input.anchor_hole ?? '');
      let comp = sim().components.find((c) => c.id === cid);
      const bb = sim().components.find((c) => c.id === bid);
      if (!comp || !bb || !isBreadboard(bb.metadataId)) throw new ToolError('Component or breadboard not found.');
      const target = breadboardHoles(bb.metadataId)?.find((h) => h.name === hole);
      if (!target) throw new ToolError(`Unknown breadboard hole "${hole}".`);
      const isTactileButton = comp.metadataId === 'pushbutton' || comp.metadataId === 'pushbutton-6mm';
      if (isTactileButton && !/^\d+[tb]\.[a-j]$/.test(hole)) {
        throw new ToolError('A tactile pushbutton must anchor in a terminal-strip hole, never a power rail; it will be rotated to straddle the centre trench.');
      }
      if (sim().wires.some((w) => !w.bb && ((w.start.componentId === cid) || (w.end.componentId === cid)))) throw new ToolError('Component already has visible wires; remove/review them before seating.');
      const mountedPins = await waitForMountedPins(cid);
      if (!mountedPins) throw new ToolError('Component pin geometry is still mounting; no changes were made. Retry seating after the part appears on the canvas.');
      const beforePosition = { x: comp.x, y: comp.y };
      const beforeProperties = { ...(comp.properties ?? {}) };
      // A 4-pin tactile switch must straddle the breadboard's centre trench:
      // its left/right contact pairs become the top/bottom banks at 90°.
      // Match the manual drag behaviour and preserve an explicit user angle.
      const currentRotation = ((Number(comp.properties?.rotation) || 0) % 360 + 360) % 360;
      if (isTactileButton && currentRotation !== 90 && currentRotation !== 270) {
        const rotated = { ...comp.properties, rotation: 90 };
        sim().updateComponent(cid, { properties: rotated });
        comp = sim().components.find((c) => c.id === cid) ?? comp;
        await settleDom();
      }
      let pos = resolveSeatPosition(comp, bid, pin, target.x, target.y, sim().components);
      if (!pos) {
        // A slightly wrong bank/column or DOM-measurement residual should not
        // cost a full LLM retry. Fall back to the nearest valid full-footprint
        // placement, preserving the requested area while keeping every leg
        // electrically valid.
        const solved = seatOnDrop(comp, comp.x, comp.y, sim().components);
        if (solved) pos = { x: solved.x, y: solved.y };
      }
      if (!pos) throw new ToolError('Component pin geometry not mounted yet; retry after the canvas renders.');
      // Keep the requested anchor translation stable. Breadboard hole/strip
      // semantics are handled by the explicit anchor the agent inspected;
      // do not re-solve into a different column and create extra jumpers.
      const finalPos = pos;
      sim().updateComponent(cid, finalPos);
      await settleDom();
      sim().reseatComponentOnBreadboard(cid);
      const seatingWires = sim().wires.filter((w) => w.bb && (w.start.componentId === cid || w.end.componentId === cid));
      const seated = seatingWires.map((w) => `${w.start.pinName}->${w.end.pinName}`);
      const pinInfo = mountedPins ?? resolvePins(cid);
      const expectedPins = pinInfo ? [...new Set(pinInfo.map((p) => p.name))] : [];
      const seatedPins = new Set(seatingWires.map((w) => w.start.componentId === cid ? w.start.pinName : w.end.pinName));
      const missingPins = pinInfo
        ? expectedPins.filter((name) => !seatedPins.has(name))
        : ['<pin geometry unavailable>'];
      const holeKeys = new Set<string>();
      const conflictingHoles: string[] = [];
      const pinHoles: Array<{ pinName: string; holeName: string }> = [];
      for (const wire of seatingWires) {
        const componentEnd = wire.start.componentId === cid ? wire.start : wire.end;
        const bbEnd = wire.start.componentId === bid ? wire.start : wire.end;
        pinHoles.push({ pinName: componentEnd.pinName, holeName: bbEnd.pinName });
        const key = `${bbEnd.componentId}:${bbEnd.pinName}`;
        if (holeKeys.has(key)) conflictingHoles.push(key);
        holeKeys.add(key);
        const occupiedByOther = sim().wires.some((other) =>
          other !== wire && other.start.componentId !== cid && other.end.componentId !== cid &&
          ((other.start.componentId === bbEnd.componentId && other.start.pinName === bbEnd.pinName) ||
            (other.end.componentId === bbEnd.componentId && other.end.pinName === bbEnd.pinName)));
        if (occupiedByOther) conflictingHoles.push(key);
      }
      const buttonLayoutError = validateTactileButtonSeating(comp.metadataId, pinHoles);
      if (!seated.length || missingPins.length > 0 || conflictingHoles.length > 0 || buttonLayoutError) {
        // Do not leave a half-seated part behind after a bad anchor. Roll back
        // before returning the deterministic error so the model can choose a
        // different listed free hole without rebuilding the whole circuit.
        sim().updateComponent(cid, { ...beforePosition, properties: beforeProperties });
        await settleDom();
        sim().reseatComponentOnBreadboard(cid);
        const detail = [
          missingPins.length ? `missing pins: ${missingPins.join(', ')}` : '',
          conflictingHoles.length ? `occupied/duplicate holes: ${[...new Set(conflictingHoles)].join(', ')}` : '',
          buttonLayoutError ?? '',
        ].filter(Boolean).join('; ');
        throw new ToolError(`Seating rejected and rolled back (${detail || 'no valid seating'}). Choose a different exact free hole/group from inspect_breadboard.`);
      }
      const externalHoles: Record<string, string> = {};
      for (const wire of seatingWires) {
        const componentEnd = wire.start.componentId === cid ? wire.start : wire.end;
        const breadboardEnd = wire.start.componentId === bid ? wire.start : wire.end;
        externalHoles[componentEnd.pinName] = resolveAgentBreadboardHole(bid, breadboardEnd.pinName);
      }
      return JSON.stringify({
        component_id: cid,
        breadboard_id: bid,
        anchor: `${pin}->${hole}`,
        position: finalPos,
        seating: seated,
        external_connection_holes: externalHoles,
        next: 'Use external_connection_holes exactly for board/rail wires. They are free sibling holes in the same electrical strips; never guess top/bottom bank or wire to seated component legs.',
      });
    }

    case 'remove_wire': {
      const id = String(input.id ?? '');
      const target = sim().wires.find((w) => w.id === id);
      if (!target) throw new ToolError(`Wire "${id}" not found.`);
      if (ctx.turnMemory?.createdWireIds?.has(id)) {
        return `Wire "${id}" was created successfully earlier in this turn; keep it and continue. Start a new turn if you explicitly need to change it.`;
      }
      if (!target.bb) {
        ctx.turnMemory?.removedWireFingerprints.add(
          wireTopologyFingerprint(target.start.componentId, target.start.pinName, target.end.componentId, target.end.pinName),
        );
      }
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
      const activeBeforeRun = sim().boards.find((b) => b.id === sim().activeBoardId);
      const memory = ctx.turnMemory;
      const alreadyRanThisEpoch = memory && memory.runEpoch === (memory.mutationEpoch ?? 0);
      if (activeBeforeRun?.running && alreadyRanThisEpoch) {
        return `Simulation is already running on board "${activeBeforeRun.id}"; do not restart it. Use observe_simulation once.`;
      }
      if (memory) memory.runEpoch = memory.mutationEpoch ?? 0;
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
      const safetyIssues = analyzeHardwareSafety({
        boards: sim().boards.map((board) => ({ id: board.id, boardKind: board.boardKind })),
        components: sim().components.map((component) => ({
          id: component.id,
          metadataId: component.metadataId,
          properties: component.properties,
        })),
        wires: sim().wires,
      });
      const result = await verifyCircuitFromStore();
      if (!result) {
        const safetyText = safetyIssues.length
          ? `\nHARDWARE SAFETY:\n${safetyIssues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')}`
          : '';
        return (
          'Pre-flight check has nothing to analyse yet (no board or power source on the canvas), ' +
          'or the solver could not run. Not a failure — continue, and verify behaviour after running.' +
          safetyText
        );
      }
      const fmtIssue = (i: { code: string; componentId?: string; message: string }) =>
        `- [${i.code}]${i.componentId ? ` ${i.componentId}:` : ''} ${i.message}`;
      if (result.errors.length === 0 && result.warnings.length === 0 && safetyIssues.length === 0) {
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
      if (safetyIssues.length > 0) {
        parts.push(
          `HARDWARE SAFETY (deterministic checks):\n${safetyIssues
            .map((issue) => `- [${issue.severity}] [${issue.code}] ${issue.message}`)
            .join('\n')}`,
        );
      }
      return parts.join('\n');
    }

    case 'check_hardware_safety': {
      const result = analyzeHardwareSafety({
        boards: sim().boards.map((board) => ({ id: board.id, boardKind: board.boardKind })),
        components: sim().components.map((component) => ({
          id: component.id,
          metadataId: component.metadataId,
          properties: component.properties,
        })),
        wires: sim().wires,
      });
      if (result.length === 0) {
        return 'HARDWARE SAFETY: no deterministic hazards detected. This is not a substitute for checking the physical parts, voltage source, and datasheets.';
      }
      return [
        'HARDWARE SAFETY AUDIT (deterministic graph checks):',
        ...result.map((issue) => `${issue.severity.toUpperCase()} [${issue.code}]${issue.componentIds?.length ? ` ${issue.componentIds.join(',')}:` : ''} ${issue.message}`),
        'Physical review is still required for unknown modules and real power supplies.',
      ].join('\n');
    }

    case 'lint_code_wiring': {
      const board = resolveBoard(input.board_id ? String(input.board_id) : undefined);
      const files = editor()
        .getGroupFiles(board.activeFileGroupId)
        .map((file) => ({ name: file.name, content: file.content }));
      const result = lintCodeWiring({
        board: { id: board.id, boardKind: board.boardKind },
        files,
        components: sim().components.map((component) => ({
          id: component.id,
          metadataId: component.metadataId,
        })),
        wires: sim().wires,
      });
      return formatCodeWiringLint(result);
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
  inspect_breadboard: { zh: '檢查麵包板', en: 'Inspect breadboard' },
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
  check_hardware_safety: { zh: '檢查硬體安全', en: 'Hardware safety audit' },
  lint_code_wiring: { zh: '檢查程式接線', en: 'Lint code wiring' },
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
    case 'lint_code_wiring':
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
