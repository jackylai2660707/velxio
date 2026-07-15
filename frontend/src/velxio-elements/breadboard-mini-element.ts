/**
 * <velxio-breadboard-mini> — 170-point mini solderless breadboard.
 *
 * 17 terminal-strip columns × two 5-hole banks (rows a-e top, f-j bottom),
 * no power rails. Pin names follow the Wokwi convention:
 * `${col}t.${a-e}` / `${col}b.${f-j}` (see utils/breadboardNets.ts).
 *
 * Passive — internal column joining happens in NetlistBuilder / the digital
 * trace via breadboardGroupKey. pinInfo (170 entries) is precomputed at
 * module load so the getter stays cheap for the pin overlay.
 */

const PITCH = 9.6;
const COLS = 17;
const GRID_LEFT = 14.4;
const ROW_Y: Record<string, number> = {
  a: 14.4, b: 24.0, c: 33.6, d: 43.2, e: 52.8,
  f: 76.8, g: 86.4, h: 96.0, i: 105.6, j: 115.2,
};
const WIDTH = GRID_LEFT * 2 + (COLS - 1) * PITCH; // 182.4
const HEIGHT = 129.6;

export interface BreadboardMiniPin {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: [];
}

function buildPins(): BreadboardMiniPin[] {
  const pins: BreadboardMiniPin[] = [];
  let n = 1;
  for (let col = 1; col <= COLS; col++) {
    const x = GRID_LEFT + (col - 1) * PITCH;
    for (const row of ['a', 'b', 'c', 'd', 'e'] as const) {
      pins.push({ name: `${col}t.${row}`, x, y: ROW_Y[row], number: n++, signals: [] });
    }
    for (const row of ['f', 'g', 'h', 'i', 'j'] as const) {
      pins.push({ name: `${col}b.${row}`, x, y: ROW_Y[row], number: n++, signals: [] });
    }
  }
  return pins;
}

const PINS: readonly BreadboardMiniPin[] = buildPins();

function buildSvg(): string {
  const parts: string[] = [];
  parts.push(
    `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="5" fill="#ffffff" stroke="#d4d0c8"/>`,
    `<rect x="3" y="${59.5}" width="${WIDTH - 6}" height="11" rx="2" fill="#eceae4"/>`,
  );
  for (const p of PINS) {
    parts.push(
      `<rect x="${(p.x - 1.6).toFixed(1)}" y="${(p.y - 1.6).toFixed(1)}" width="3.2" height="3.2" rx="0.8" fill="#333"/>`,
    );
  }
  for (let col = 5; col <= COLS; col += 5) {
    const x = GRID_LEFT + (col - 1) * PITCH;
    parts.push(
      `<text x="${x}" y="${7.8}" font-size="6" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${col}</text>`,
      `<text x="${x}" y="${125.5}" font-size="6" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${col}</text>`,
    );
  }
  for (const row of Object.keys(ROW_Y)) {
    for (const x of [5.5, WIDTH - 5.5]) {
      parts.push(
        `<text x="${x}" y="${ROW_Y[row] + 2.2}" font-size="6" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${row}</text>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

let svgCache: string | null = null;

export class BreadboardMiniElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    if (!svgCache) svgCache = buildSvg();
    this.shadowRoot!.innerHTML = svgCache;
  }

  get pinInfo() {
    return PINS as unknown as Array<{ name: string; x: number; y: number; number: number }>;
  }
}

if (!customElements.get('velxio-breadboard-mini')) {
  customElements.define('velxio-breadboard-mini', BreadboardMiniElement);
}
