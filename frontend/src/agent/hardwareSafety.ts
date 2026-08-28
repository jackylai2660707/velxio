/**
 * Deterministic, conservative hardware checks for the agent.
 *
 * Prompt text can explain electronics, but it cannot be the safety boundary.
 * This module intentionally uses only the persisted graph (no DOM and no
 * simulator side effects) and reports hazards before a tool mutates state.
 */
import { boardPinGroupFor } from '../simulation/spice/boardPinGroups';
import { boardPinToNumber } from '../utils/boardPinMapping';

export type HardwareIssueSeverity = 'error' | 'warning';
export type HardwareIssueCode =
  | 'gpio-overvoltage'
  | 'gpio-contention'
  | 'load-on-gpio-power'
  | 'level-shift-required'
  | 'missing-common-ground';

export interface HardwareIssue {
  severity: HardwareIssueSeverity;
  code: HardwareIssueCode;
  message: string;
  componentIds?: string[];
}

export interface HardwareSafetyInput {
  boards: Array<{ id: string; boardKind: string }>;
  components: Array<{ id: string; metadataId: string; properties?: Record<string, unknown> }>;
  wires: Array<{
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
    bb?: boolean;
  }>;
}

const POWER_RE = /^(?:vcc|vdd|vss|vin|vbus|vsys|vbat|5v|3v3|3\.3v|3v|v\+|v-)(?:[._-]\d+)?$/i;
const GND_RE = /^(?:gnd|ground|vss)(?:[._-]?\d+)?$/i;
const TX_RE = /^(?:tx|tx\d*|txd)$/i;
const RX_RE = /^(?:rx|rx\d*|rxd)$/i;

function isEsp32(kind: string): boolean {
  return kind.startsWith('esp32') || kind.includes('xiao-esp32') || kind.includes('nano-esp32') || kind.includes('lolin32');
}

function isBoardPower(kind: string, pin: string): number | null {
  const group = boardPinGroupFor(kind);
  if (group.gnd.some((p) => p.toLowerCase() === pin.toLowerCase())) return null;
  if (group.vcc_pins.some((p) => p.toLowerCase() === pin.toLowerCase())) return group.vcc;
  if (group.aux?.pins.some((p) => p.toLowerCase() === pin.toLowerCase())) return group.aux.volts;
  return null;
}

function isBoardGpio(kind: string, pin: string): boolean {
  if (POWER_RE.test(pin) || GND_RE.test(pin)) return false;
  return boardPinToNumber(kind, pin) !== null && boardPinToNumber(kind, pin)! >= 0;
}

/** Analyze obvious real-hardware hazards. False negatives are preferable to
 * inventing a fault; unresolved/unknown components are left for review. */
export function analyzeHardwareSafety(input: HardwareSafetyInput): HardwareIssue[] {
  const boardById = new Map(input.boards.map((b) => [b.id, b]));
  const compById = new Map(input.components.map((c) => [c.id, c]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p) { parent.set(x, x); return x; }
    if (p === x) return x;
    const root = find(p); parent.set(x, root); return root;
  };
  const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const node = (id: string, pin: string) => `${id}:${pin}`;
  for (const w of input.wires) {
    // Seating wires are invisible only cosmetically; electrically they join
    // the component leg to its breadboard hole and must participate here.
    union(node(w.start.componentId, w.start.pinName), node(w.end.componentId, w.end.pinName));
  }
  const nets = new Map<string, Array<{ id: string; pin: string; board?: { id: string; boardKind: string }; comp?: { id: string; metadataId: string; properties?: Record<string, unknown> } }>>();
  const add = (id: string, pin: string) => {
    const root = find(node(id, pin));
    const list = nets.get(root) ?? [];
    list.push({ id, pin, board: boardById.get(id), comp: compById.get(id) });
    nets.set(root, list);
  };
  for (const w of input.wires) { add(w.start.componentId, w.start.pinName); add(w.end.componentId, w.end.pinName); }

  const issues: HardwareIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: HardwareIssue) => {
    const key = `${issue.code}:${(issue.componentIds ?? []).join(',')}:${issue.message}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  };

  for (const members of nets.values()) {
    const gpio = members.filter((m) => m.board && isBoardGpio(m.board.boardKind, m.pin));
    const supplies = members.flatMap((m) => m.board ? [{ m, volts: isBoardPower(m.board.boardKind, m.pin) }] : []).filter((x): x is { m: typeof members[number]; volts: number } => x.volts !== null);
    const espGpio = gpio.filter((m) => isEsp32(m.board!.boardKind));
    const maxSupply = supplies.reduce((n, x) => Math.max(n, x.volts), 0);
    if (espGpio.length && maxSupply > 3.6) {
      push({ severity: 'error', code: 'gpio-overvoltage', componentIds: espGpio.map((m) => m.id), message: `ESP32 GPIO ${espGpio.map((m) => `${m.id}:${m.pin}`).join(', ')} shares a ${maxSupply.toFixed(1)} V supply net. ESP32 GPIO is 3.3 V-only; add a divider/level shifter.` });
    }
    if (gpio.length > 1) {
      const distinct = new Set(gpio.map((m) => `${m.id}:${m.pin}`));
      if (distinct.size > 1) push({ severity: 'warning', code: 'gpio-contention', componentIds: gpio.map((m) => m.id), message: `Multiple MCU GPIO pins share one net (${gpio.map((m) => `${m.id}:${m.pin}`).join(', ')}). This may be a legitimate bus (I²C/SPI/UART), but verify input/output direction; two push-pull outputs can fight and damage hardware.` });
    }
    const loads = members.filter((m) => m.comp && /^(servo|motor|relay|dc-motor|stepper)/i.test(m.comp.metadataId));
    if (loads.length && gpio.length) {
      const powerLoad = loads.some((m) => /^(?:v\+|vcc|vin|5v|vdd|coil\+|motor\+|power)$/i.test(m.pin));
      if (powerLoad) push({ severity: 'error', code: 'load-on-gpio-power', componentIds: [...loads, ...gpio].map((m) => m.id), message: `A motor/servo/relay supply pin is tied to MCU GPIO (${gpio.map((m) => `${m.id}:${m.pin}`).join(', ')}). Use an external supply and a transistor/driver, with common ground.` });
    }
    const echo = members.some((m) => m.comp?.metadataId === 'hc-sr04' && /^echo$/i.test(m.pin));
    if (echo && espGpio.length) push({ severity: 'warning', code: 'level-shift-required', componentIds: members.map((m) => m.id), message: 'HC-SR04 Echo is a 5 V signal connected to an ESP32 GPIO. Real hardware needs a resistor divider or level shifter (the simulator may tolerate it).' });
    const tx = members.filter((m) => m.board && TX_RE.test(m.pin));
    const rx = members.filter((m) => m.board && RX_RE.test(m.pin));
    if (tx.length > 1 && rx.length === 0) push({ severity: 'warning', code: 'gpio-contention', componentIds: tx.map((m) => m.id), message: `UART TX pins share a net (${tx.map((m) => `${m.id}:${m.pin}`).join(', ')}), but no RX endpoint is present. Check TX→RX direction.` });
  }
  // A connected board signal should normally have a return reference. This is
  // a warning only: isolated modules can legitimately be unpowered while a
  // student is building incrementally.
  for (const b of input.boards) {
    const hasSignal = input.wires.some((w) => w.start.componentId === b.id || w.end.componentId === b.id);
    const hasGround = input.wires.some((w) => [w.start, w.end].some((e) => e.componentId === b.id && GND_RE.test(e.pinName)));
    if (hasSignal && !hasGround) push({ severity: 'warning', code: 'missing-common-ground', componentIds: [b.id], message: `${b.boardKind} ${b.id} has signal wiring but no GND connection. Sensors, drivers and buses need a common ground reference.` });
  }
  return issues;
}
