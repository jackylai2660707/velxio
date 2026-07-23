/**
 * Max7219Element.ts — MAX7219 8×8 LED dot-matrix module (velxio-native).
 *
 * The classic Chinese-market classroom module: MAX7219 driver + 8×8 red LED
 * matrix on one PCB with a 5-pin header (VCC GND DIN CS CLK) and a matching
 * output header (DOUT side) for daisy-chaining — visual only; the simulation
 * currently models a single module.
 *
 * Display state lives in `pixels` — a Uint8Array(8) of row bitmaps
 * (bit 7 = leftmost column, matching MAX7219 digit/segment order as used by
 * LedControl's setLed(addr, row, col)). The part simulation
 * (simulation/parts/Max7219Part.ts) decodes SPI/shiftOut traffic and writes
 * this property; the setter repaints the dots.
 */

const PIN_INFO = [
  { name: 'VCC', x: 6, y: 24, number: 1, signals: [{ type: 'power', signal: 'VCC' }] },
  { name: 'GND', x: 6, y: 44, number: 2, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'DIN', x: 6, y: 64, number: 3, signals: [] as Array<unknown> },
  { name: 'CS', x: 6, y: 84, number: 4, signals: [] as Array<unknown> },
  { name: 'CLK', x: 6, y: 104, number: 5, signals: [] as Array<unknown> },
];

const SIZE = 128; // module is ~32mm square
const GRID_ORIGIN = 24;
const DOT_STEP = 12.5;

class Max7219Element extends HTMLElement {
  readonly pinInfo = PIN_INFO;

  private _pixels = new Uint8Array(8);
  private _shutdown = true; // powers up in shutdown per datasheet
  private _testMode = false;
  private dots: SVGCircleElement[][] = [];

  get pixels(): Uint8Array {
    return this._pixels;
  }
  set pixels(v: Uint8Array) {
    this._pixels = v instanceof Uint8Array ? v : Uint8Array.from(v ?? []);
    this.repaint();
  }

  get shutdown(): boolean {
    return this._shutdown;
  }
  set shutdown(v: boolean) {
    this._shutdown = !!v;
    this.repaint();
  }

  get testMode(): boolean {
    return this._testMode;
  }
  set testMode(v: boolean) {
    this._testMode = !!v;
    this.repaint();
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg   { display: block; overflow: visible; }
        .pin-label { font: 600 6px monospace; fill: #cfd8e3; pointer-events: none; }
      </style>
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
        <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="6" fill="#123d1a" />
        <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="3" fill="#151515" />
        <g id="dots"></g>
        <!-- input header pads -->
        ${PIN_INFO.map(
          (p) =>
            `<circle cx="${p.x}" cy="${p.y}" r="3.4" fill="#c9a34a" stroke="#7a6222" />` +
            `<text class="pin-label" x="13" y="${p.y + 2}">${p.name}</text>`,
        ).join('\n        ')}
        <text x="${SIZE - 6}" y="${SIZE - 4}" text-anchor="end" font-family="monospace" font-size="7" fill="#8fce9a">MAX7219</text>
      </svg>`;
    const dotsGroup = root.querySelector('#dots')!;
    for (let row = 0; row < 8; row++) {
      const rowDots: SVGCircleElement[] = [];
      for (let col = 0; col < 8; col++) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', String(GRID_ORIGIN + col * DOT_STEP));
        c.setAttribute('cy', String(GRID_ORIGIN + row * DOT_STEP));
        c.setAttribute('r', '4.6');
        c.setAttribute('fill', '#3a1010');
        dotsGroup.appendChild(c);
        rowDots.push(c);
      }
      this.dots.push(rowDots);
    }
  }

  private repaint(): void {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const on = this._testMode
          ? true
          : !this._shutdown && ((this._pixels[row] ?? 0) & (0x80 >> col)) !== 0;
        this.dots[row]?.[col]?.setAttribute('fill', on ? '#ff3b30' : '#3a1010');
      }
    }
  }
}

if (!customElements.get('velxio-max7219')) {
  customElements.define('velxio-max7219', Max7219Element);
}
