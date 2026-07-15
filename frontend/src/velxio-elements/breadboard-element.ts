/**
 * <velxio-breadboard> — full-size 830-point solderless breadboard.
 *
 * 63 terminal-strip columns × two 5-hole banks (rows a-e top, f-j bottom)
 * plus four power rails (+/- top and bottom, 50 holes each in 5-hole groups).
 * Pin names follow the Wokwi convention (see utils/breadboardNets.ts):
 *   holes `${col}t.${a-e}` / `${col}b.${f-j}`, rails `tp.N` `tn.N` `bp.N` `bn.N`.
 *
 * Purely passive: the electrical joining of each column/rail happens in
 * NetlistBuilder + the digital trace via breadboardGroupKey — this element
 * only renders and exposes pinInfo. The pinInfo array is precomputed at
 * module load (830 entries) so the getter stays cheap for the pin overlay,
 * which re-reads it on every measure (see CLAUDE.md §6a).
 */

const PITCH = 9.6; // 0.1in in wokwi-elements CSS px
const COLS = 63;
const RAIL_HOLES = 50; // 10 groups of 5

// Layout (CSS px). Terminal grid is centered; rails hug the long edges.
const GRID_LEFT = 19.2; // x of column 1
const RAIL_LEFT = GRID_LEFT + ((COLS - 1) * PITCH - (RAIL_HOLES - 1 + 9) * PITCH) / 2;
const ROW_Y: Record<string, number> = {
  // top rails
  'tp': 16.8,
  'tn': 26.4,
  // bank a-e
  a: 55.2, b: 64.8, c: 74.4, d: 84.0, e: 93.6,
  // bank f-j (below the center channel)
  f: 122.4, g: 132.0, h: 141.6, i: 151.2, j: 160.8,
  // bottom rails
  'bp': 189.6,
  'bn': 199.2,
};
const WIDTH = GRID_LEFT * 2 + (COLS - 1) * PITCH; // 614.4
const HEIGHT = 216;

function railX(n: number): number {
  // 10 groups of 5 with one extra pitch between groups
  const idx = n - 1;
  return RAIL_LEFT + (idx + Math.floor(idx / 5)) * PITCH;
}

export interface BreadboardPin {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: [];
}

function buildPins(): BreadboardPin[] {
  const pins: BreadboardPin[] = [];
  let n = 1;
  for (const rail of ['tp', 'tn', 'bp', 'bn'] as const) {
    for (let i = 1; i <= RAIL_HOLES; i++) {
      pins.push({ name: `${rail}.${i}`, x: railX(i), y: ROW_Y[rail], number: n++, signals: [] });
    }
  }
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

const PINS: readonly BreadboardPin[] = buildPins();

function holeRect(x: number, y: number): string {
  return `<rect x="${(x - 1.6).toFixed(1)}" y="${(y - 1.6).toFixed(1)}" width="3.2" height="3.2" rx="0.8" fill="#333"/>`;
}

function buildSvg(): string {
  const parts: string[] = [];
  parts.push(
    `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`,
    // body
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="6" fill="#f4f1ec" stroke="#d4d0c8"/>`,
    // rail separator lines: red above +, blue below -
    `<line x1="8" y1="9.6" x2="${WIDTH - 8}" y2="9.6" stroke="#e05050" stroke-width="1.6"/>`,
    `<line x1="8" y1="33.6" x2="${WIDTH - 8}" y2="33.6" stroke="#5070e0" stroke-width="1.6"/>`,
    `<line x1="8" y1="182.4" x2="${WIDTH - 8}" y2="182.4" stroke="#e05050" stroke-width="1.6"/>`,
    `<line x1="8" y1="206.4" x2="${WIDTH - 8}" y2="206.4" stroke="#5070e0" stroke-width="1.6"/>`,
    // center channel
    `<rect x="4" y="${101.5}" width="${WIDTH - 8}" height="13" rx="2" fill="#e6e2da"/>`,
  );
  // holes
  for (const p of PINS) parts.push(holeRect(p.x, p.y));
  // column numbers every 5 columns, in both banks' margins
  for (let col = 5; col <= COLS; col += 5) {
    const x = GRID_LEFT + (col - 1) * PITCH;
    parts.push(
      `<text x="${x}" y="${47.5}" font-size="6.5" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${col}</text>`,
      `<text x="${x}" y="${174}" font-size="6.5" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${col}</text>`,
    );
  }
  // row letters on both sides
  for (const row of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    for (const x of [8.5, WIDTH - 8.5]) {
      parts.push(
        `<text x="${x}" y="${ROW_Y[row] + 2.3}" font-size="6.5" fill="#8a8578" text-anchor="middle" font-family="sans-serif">${row}</text>`,
      );
    }
  }
  // rail +/- labels
  for (const [rail, sym, color] of [
    ['tp', '+', '#e05050'], ['tn', '−', '#5070e0'],
    ['bp', '+', '#e05050'], ['bn', '−', '#5070e0'],
  ] as const) {
    for (const x of [8.5, WIDTH - 8.5]) {
      parts.push(
        `<text x="${x}" y="${ROW_Y[rail] + 2.6}" font-size="8" fill="${color}" text-anchor="middle" font-family="sans-serif">${sym}</text>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

let svgCache: string | null = null;

export class BreadboardElement extends HTMLElement {
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

if (!customElements.get('velxio-breadboard')) {
  customElements.define('velxio-breadboard', BreadboardElement);
}
