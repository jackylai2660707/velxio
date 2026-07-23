/**
 * Simulation observation for the AI assistant.
 *
 * Reads the live visual state of output components straight from their DOM
 * web-component elements (the part simulations write `el.value`, `el.angle`,
 * `el.playing`, `el.characters`, `el.imageData`, … every frame) and samples
 * that state over a time window, so the agent can VERIFY behaviour — "the
 * LED actually blinks at ~1 Hz", "the LCD really shows Temp: 24.0" — instead
 * of claiming success blind.
 *
 * The agent loop awaits this promise while the simulation keeps running
 * (workers / requestAnimationFrame), so sampling does not stall the sim.
 */

import { useSimulatorStore, getBoardPinManager } from '../store/useSimulatorStore';

const SAMPLE_INTERVAL_MS = 100;
export const MAX_OBSERVE_MS = 5000;
const REPORT_BUDGET = 3500;

type Observable = number | boolean;

/** Element props the part simulations maintain that are cheap to sample. */
const SAMPLED_PROPS = ['value', 'brightness', 'angle', 'playing', 'pressed'] as const;

function getEl(id: string): (HTMLElement & Record<string, unknown>) | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as (HTMLElement & Record<string, unknown>) | null;
}

/** Read the sampled (scalar) props a component element currently exposes. */
function readScalars(el: Record<string, unknown>): Record<string, Observable> {
  const out: Record<string, Observable> = {};
  for (const prop of SAMPLED_PROPS) {
    const v = el[prop];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[prop] = v;
  }
  return out;
}

/**
 * Snapshot the scalar output state of components (for interact's
 * before → after diff). Keyed by component id.
 */
export function snapshotOutputs(componentIds?: string[]): Map<string, Record<string, Observable>> {
  const sim = useSimulatorStore.getState();
  const targets = sim.components.filter((c) => !componentIds || componentIds.includes(c.id));
  const snap = new Map<string, Record<string, Observable>>();
  for (const c of targets) {
    const el = getEl(c.id);
    if (!el) continue;
    const scalars = readScalars(el);
    if (Object.keys(scalars).length > 0) snap.set(c.id, scalars);
  }
  return snap;
}

/** Human-readable lines for what changed between two snapshots. */
export function diffSnapshots(
  before: Map<string, Record<string, Observable>>,
  after: Map<string, Record<string, Observable>>,
): string[] {
  const lines: string[] = [];
  for (const [id, afterProps] of after) {
    const beforeProps = before.get(id) ?? {};
    for (const [prop, afterVal] of Object.entries(afterProps)) {
      const beforeVal = beforeProps[prop];
      if (beforeVal === undefined || sameValue(beforeVal, afterVal)) continue;
      lines.push(`${id}.${prop}: ${fmt(beforeVal)} → ${fmt(afterVal)}`);
    }
  }
  return lines;
}

function sameValue(a: Observable, b: Observable): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-3;
  return a === b;
}

function fmt(v: Observable): string {
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// ── Rich (non-scalar) readers ──────────────────────────────────────────────

/** 7-segment pattern [a,b,c,d,e,f,g] → digit. */
const SEGMENT_DIGITS: Record<string, string> = {
  '1111110': '0',
  '0110000': '1',
  '1101101': '2',
  '1111001': '3',
  '0110011': '4',
  '1011011': '5',
  '1011111': '6',
  '1110000': '7',
  '1111111': '8',
  '1111011': '9',
  '0000000': ' ',
  '0000001': '-',
};

export function decodeSevenSegment(values: unknown): string | null {
  if (!Array.isArray(values) || values.length < 7) return null;
  const key = values
    .slice(0, 7)
    .map((v) => (v ? '1' : '0'))
    .join('');
  const digit = SEGMENT_DIGITS[key] ?? '?';
  const dp = values[7] ? ' (decimal point on)' : '';
  return `showing "${digit}"${dp} [segments a-g: ${key}]`;
}

export function decodeLcd(characters: unknown): string | null {
  if (!(characters instanceof Uint8Array) || characters.length === 0) return null;
  // 16x2 (32 chars) and 20x4 (80 chars) are the two shipped LCDs.
  const cols = characters.length % 20 === 0 ? 20 : 16;
  const rows = Math.max(1, Math.round(characters.length / cols));
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const text = Array.from(characters.slice(r * cols, (r + 1) * cols))
      .map((code) => (code >= 32 && code <= 126 ? String.fromCharCode(code) : '?'))
      .join('');
    lines.push(`  row ${r}: "${text}"`);
  }
  return lines.join('\n');
}

export function describeOled(imageData: unknown): string | null {
  const img = imageData as ImageData | undefined;
  if (!img || typeof img.width !== 'number' || !img.data) return null;
  const { width, height, data } = img;
  let lit = 0;
  const COLS = 32;
  const ROWS = 8;
  const blockW = Math.max(1, Math.floor(width / COLS));
  const blockH = Math.max(1, Math.floor(height / ROWS));
  const blocks: number[][] = Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > 96) {
        lit++;
        const by = Math.min(ROWS - 1, Math.floor(y / blockH));
        const bx = Math.min(COLS - 1, Math.floor(x / blockW));
        blocks[by][bx]++;
      }
    }
  }
  if (lit === 0) return 'display is blank (0 lit pixels)';
  const perBlock = blockW * blockH;
  const art = blocks
    .map((row) => '  ' + row.map((n) => (n / perBlock > 0.125 ? '#' : '.')).join(''))
    .join('\n');
  return `${lit} lit pixels; coarse ${COLS}x${ROWS} view (# = lit area):\n${art}`;
}

/** MAX7219 8×8 dot matrix — `pixels` is 8 row bytes, bit 7 = leftmost dot. */
export function describeMatrix(pixels: unknown): string | null {
  if (!(pixels instanceof Uint8Array) || pixels.length !== 8) return null;
  let lit = 0;
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let line = '  ';
    for (let b = 7; b >= 0; b--) {
      const on = (pixels[r] >> b) & 1;
      lit += on;
      line += on ? '#' : '.';
    }
    rows.push(line);
  }
  if (lit === 0) return 'matrix is blank (0 of 64 dots lit)';
  return `${lit} of 64 dots lit (# = lit):\n${rows.join('\n')}`;
}

// ── The observation window ─────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Track {
  first: Observable;
  last: Observable;
  /** boolean: number of value flips seen across samples */
  transitions: number;
  min: number;
  max: number;
}

export interface ObserveOptions {
  durationMs?: number;
  componentIds?: string[];
}

/**
 * Observe the simulation for a time window and produce a compact text report
 * the model can reason about. Never throws — an unmounted element is simply
 * omitted.
 */
export async function observeSimulation(opts: ObserveOptions = {}): Promise<string> {
  const duration = Math.max(0, Math.min(MAX_OBSERVE_MS, opts.durationMs ?? 1500));
  const sim = useSimulatorStore.getState();
  const wanted = opts.componentIds?.length ? new Set(opts.componentIds) : null;
  const components = sim.components.filter((c) => !wanted || wanted.has(c.id));

  const serialStart = new Map<string, number>();
  for (const b of sim.boards) serialStart.set(b.id, (b.serialOutput ?? '').length);

  // Sample scalar props over the window.
  const tracks = new Map<string, Map<string, Track>>();
  const record = () => {
    for (const c of components) {
      const el = getEl(c.id);
      if (!el) continue;
      const scalars = readScalars(el);
      let compTracks = tracks.get(c.id);
      if (!compTracks) {
        compTracks = new Map();
        tracks.set(c.id, compTracks);
      }
      for (const [prop, v] of Object.entries(scalars)) {
        const t = compTracks.get(prop);
        if (!t) {
          compTracks.set(prop, {
            first: v,
            last: v,
            transitions: 0,
            min: typeof v === 'number' ? v : 0,
            max: typeof v === 'number' ? v : 0,
          });
        } else {
          if (typeof v === 'boolean' && v !== t.last) t.transitions++;
          if (typeof v === 'number' && typeof t.last === 'number' && !sameValue(v, t.last)) {
            t.transitions++;
          }
          if (typeof v === 'number') {
            t.min = Math.min(t.min, v);
            t.max = Math.max(t.max, v);
          }
          t.last = v;
        }
      }
    }
  };

  record();
  const steps = Math.floor(duration / SAMPLE_INTERVAL_MS);
  for (let i = 0; i < steps; i++) {
    await sleep(SAMPLE_INTERVAL_MS);
    record();
  }

  // Re-read store state — burnt/serial/running may have changed in the window.
  const end = useSimulatorStore.getState();
  const lines: string[] = [];

  const runningBoards = end.boards.filter((b) => b.running);
  if (runningBoards.length === 0) {
    lines.push(
      'SIMULATION IS NOT RUNNING — values below are the static/idle state. ' +
        'Call run_simulation first to observe real behaviour.',
    );
  } else {
    lines.push(
      `Simulation running on: ${runningBoards.map((b) => b.id).join(', ')} ` +
        `(observed for ${duration}ms).`,
    );
  }

  // Burnt components — always worth shouting about.
  if (end.burntComponents.size > 0) {
    lines.push(
      `⚠ BURNT COMPONENTS (destroyed by overcurrent — fix the circuit and restart): ` +
        [...end.burntComponents].join(', '),
    );
  }

  // Per-component report.
  const compLines: string[] = [];
  for (const c of components) {
    const el = getEl(c.id);
    if (!el) continue;
    const parts: string[] = [];

    // Rich payloads first (displays).
    const lcd = decodeLcd(el.characters);
    if (lcd) parts.push(`text:\n${lcd}`);
    if (!lcd) {
      const seg = decodeSevenSegment(el.values);
      if (seg) parts.push(seg);
    }
    const oled = describeOled(el.imageData);
    if (oled) parts.push(oled);
    const matrix = describeMatrix(el.pixels);
    if (matrix) parts.push(matrix);

    // Sampled scalars.
    const compTracks = tracks.get(c.id);
    if (compTracks) {
      for (const [prop, t] of compTracks) {
        if (typeof t.last === 'boolean') {
          let s = `${prop}: ${fmt(t.last)}`;
          if (t.transitions > 0) {
            const hz = t.transitions / 2 / (duration / 1000);
            s += ` — toggled ${t.transitions}x in ${duration}ms (~${hz.toFixed(1)} Hz)`;
          }
          parts.push(s);
        } else {
          let s = `${prop}: ${fmt(t.last)}`;
          if (t.transitions > 0 && !sameValue(t.min, t.max)) {
            s = `${prop}: ${fmt(t.first)} → ${fmt(t.last)} (range ${fmt(t.min)}–${fmt(t.max)})`;
          }
          parts.push(s);
        }
      }
    }

    if (parts.length > 0) {
      const label = c.metadataId + (end.burntComponents.has(c.id) ? ' [BURNT]' : '');
      compLines.push(`- ${c.id} (${label}): ${parts.join('; ')}`);
    }
  }
  if (compLines.length > 0) {
    lines.push('COMPONENTS:');
    lines.push(...compLines);
  } else {
    lines.push('COMPONENTS: (none observable — no output components on the canvas?)');
  }

  // Wired digital pin levels per board.
  for (const b of end.boards) {
    const pm = getBoardPinManager(b.id);
    if (!pm) continue;
    const wiredPins = new Set<number>();
    for (const w of end.wires) {
      for (const endpoint of [w.start, w.end]) {
        if (endpoint.componentId !== b.id) continue;
        const n = Number.parseInt(endpoint.pinName, 10);
        if (!Number.isNaN(n)) wiredPins.add(n);
      }
    }
    if (wiredPins.size === 0) continue;
    const states = [...wiredPins]
      .sort((a, z) => a - z)
      .map((n) => `${n}=${pm.getPinState(n) ? 'HIGH' : 'LOW'}`)
      .join(' ');
    lines.push(`PINS ${b.id}: ${states}`);
  }

  // Serial output appended DURING the window.
  for (const b of end.boards) {
    const startLen = serialStart.get(b.id) ?? 0;
    const out = b.serialOutput ?? '';
    const delta = out.slice(startLen);
    if (delta.trim()) {
      const clipped = delta.length > 600 ? `…${delta.slice(-600)}` : delta;
      lines.push(`SERIAL ${b.id} (new output during window):\n${clipped.trimEnd()}`);
    }
  }

  const report = lines.join('\n');
  return report.length > REPORT_BUDGET ? report.slice(0, REPORT_BUDGET) + '\n…(truncated)' : report;
}
