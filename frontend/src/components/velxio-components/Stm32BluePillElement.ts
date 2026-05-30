/**
 * STM32 board Web Components (Blue Pill, Black Pill).
 *
 * Per CLAUDE.md rule 6a, boards that take wire connections MUST be real Web
 * Components exposing a `pinInfo` getter. Renders the official wokwi-boards
 * SVG with the pin coordinates from that board.json (mm x 5 px/mm), plus an
 * overlay for the onboard PC13 LED (active-LOW: lit when PC13 is LOW).
 *
 * Pin `name`s are the real port labels ('PA9', 'PC13', ...) so examples wire
 * to them; Stm32Bridge.stm32PinNameToLinear() maps them to the backend's
 * linear pin index (port*16 + pin).
 *
 * Registers two custom elements: <velxio-stm32-bluepill> and
 * <velxio-stm32-blackpill>, selected by config.
 */

interface PinDef {
  name: string;
  x: number;
  y: number;
}

interface BoardConfig {
  svgUrl: string;
  w: number;
  h: number;
  pins: PinDef[];
  /** Onboard PC13 LED center (px). */
  led: { x: number; y: number };
}

// ── STM32 Blue Pill (F103C8) — 22.855 x 54.193 mm -> 114 x 271 px ───────────
const BLUEPILL_PINS: PinDef[] = [
  { name: 'PB12', x: 18, y: 14 }, { name: 'PB13', x: 18, y: 27 },
  { name: 'PB14', x: 18, y: 40 }, { name: 'PB15', x: 18, y: 53 },
  { name: 'PA8', x: 18, y: 65 }, { name: 'PA9', x: 18, y: 78 },
  { name: 'PA10', x: 18, y: 91 }, { name: 'PA11', x: 18, y: 103 },
  { name: 'PA12', x: 18, y: 116 }, { name: 'PA15', x: 18, y: 129 },
  { name: 'PB3', x: 18, y: 142 }, { name: 'PB4', x: 18, y: 154 },
  { name: 'PB5', x: 18, y: 167 }, { name: 'PB6', x: 18, y: 180 },
  { name: 'PB7', x: 18, y: 192 }, { name: 'PB8', x: 18, y: 205 },
  { name: 'PB9', x: 18, y: 218 }, { name: '5V', x: 18, y: 230 },
  { name: 'GND', x: 18, y: 243 }, { name: '3V3', x: 18, y: 256 },
  { name: 'GND', x: 96, y: 14 }, { name: 'GND', x: 96, y: 27 },
  { name: '3V3', x: 96, y: 40 }, { name: 'NRST', x: 96, y: 53 },
  { name: 'PB11', x: 96, y: 65 }, { name: 'PB10', x: 96, y: 78 },
  { name: 'PB1', x: 96, y: 91 }, { name: 'PB0', x: 96, y: 103 },
  { name: 'PA7', x: 96, y: 116 }, { name: 'PA6', x: 96, y: 129 },
  { name: 'PA5', x: 96, y: 142 }, { name: 'PA4', x: 96, y: 154 },
  { name: 'PA3', x: 96, y: 167 }, { name: 'PA2', x: 96, y: 180 },
  { name: 'PA1', x: 96, y: 192 }, { name: 'PA0', x: 96, y: 205 },
  { name: 'PC15', x: 96, y: 218 }, { name: 'PC14', x: 96, y: 230 },
  { name: 'PC13', x: 96, y: 243 }, { name: 'VBAT', x: 96, y: 256 },
];

// ── STM32 Black Pill (F411CE) — 20.695 x 53.125 mm -> 103 x 266 px ──────────
const BLACKPILL_PINS: PinDef[] = [
  { name: 'VBAT', x: 13, y: 16 }, { name: 'PC13', x: 13, y: 28 },
  { name: 'PC14', x: 13, y: 41 }, { name: 'PC15', x: 13, y: 54 },
  { name: 'NRST', x: 13, y: 67 }, { name: 'PA0', x: 13, y: 79 },
  { name: 'PA1', x: 13, y: 92 }, { name: 'PA2', x: 13, y: 105 },
  { name: 'PA3', x: 13, y: 117 }, { name: 'PA4', x: 13, y: 130 },
  { name: 'PA5', x: 13, y: 143 }, { name: 'PA6', x: 13, y: 155 },
  { name: 'PA7', x: 13, y: 168 }, { name: 'PB0', x: 13, y: 181 },
  { name: 'PB1', x: 13, y: 194 }, { name: 'PB2', x: 13, y: 206 },
  { name: 'PB10', x: 13, y: 219 }, { name: '3V3', x: 13, y: 232 },
  { name: 'GND', x: 13, y: 244 }, { name: '5V', x: 13, y: 257 },
  { name: '3V3', x: 89, y: 14 }, { name: 'GND', x: 89, y: 27 },
  { name: '5V', x: 89, y: 40 }, { name: 'PB9', x: 89, y: 53 },
  { name: 'PB8', x: 89, y: 65 }, { name: 'PB7', x: 89, y: 78 },
  { name: 'PB6', x: 89, y: 91 }, { name: 'PB5', x: 89, y: 103 },
  { name: 'PB4', x: 89, y: 116 }, { name: 'PB3', x: 89, y: 129 },
  { name: 'PA15', x: 89, y: 142 }, { name: 'PA12', x: 89, y: 154 },
  { name: 'PA11', x: 89, y: 167 }, { name: 'PA10', x: 89, y: 180 },
  { name: 'PA9', x: 89, y: 192 }, { name: 'PA8', x: 89, y: 205 },
  { name: 'PB15', x: 89, y: 218 }, { name: 'PB14', x: 89, y: 230 },
  { name: 'PB13', x: 89, y: 243 }, { name: 'PB12', x: 89, y: 256 },
];

const CONFIGS: Record<string, BoardConfig> = {
  'stm32-bluepill': {
    svgUrl: '/boards/stm32-bluepill.svg', w: 114, h: 271,
    pins: BLUEPILL_PINS, led: { x: 37, y: 228 },
  },
  'stm32-blackpill': {
    svgUrl: '/boards/stm32-blackpill.svg', w: 103, h: 266,
    pins: BLACKPILL_PINS, led: { x: 27, y: 55 },
  },
};

class Stm32BoardElement extends HTMLElement {
  static get observedAttributes() {
    return ['board-kind'];
  }
  private _ledOn = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    this.render();
  }

  private get config(): BoardConfig {
    const kind = this.getAttribute('board-kind') ?? this._defaultKind();
    return CONFIGS[kind] ?? CONFIGS['stm32-bluepill'];
  }

  private _defaultKind(): string {
    return this.tagName.toLowerCase() === 'velxio-stm32-blackpill'
      ? 'stm32-blackpill'
      : 'stm32-bluepill';
  }

  /** Pin tip coordinates in CSS px relative to element top-left (rule 6a). */
  get pinInfo(): PinDef[] {
    return this.config.pins;
  }

  /** Onboard PC13 LED (visual lit state; store passes polarity-corrected value). */
  set led(on: boolean) {
    if (this._ledOn === on) return;
    this._ledOn = on;
    const el = this.shadowRoot?.getElementById('led');
    if (el) el.style.opacity = on ? '1' : '0';
  }
  get led(): boolean {
    return this._ledOn;
  }

  private render() {
    if (!this.shadowRoot) return;
    const { svgUrl, w, h, led } = this.config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; position: relative; }
        img { display: block; }
        #led {
          position: absolute; left: ${led.x - 4}px; top: ${led.y - 4}px;
          width: 8px; height: 8px; border-radius: 50%;
          background: #ff3b30; box-shadow: 0 0 6px 2px #ff3b30;
          opacity: 0; transition: opacity 40ms linear; pointer-events: none;
        }
      </style>
      <img src="${svgUrl}" width="${w}" height="${h}" draggable="false" alt="STM32 board" />
      <div id="led"></div>
    `;
  }
}

export { Stm32BoardElement as Stm32BluePillElement };

if (!customElements.get('velxio-stm32-bluepill')) {
  customElements.define('velxio-stm32-bluepill', Stm32BoardElement);
}
if (!customElements.get('velxio-stm32-blackpill')) {
  // Separate class instance per tag name (customElements requires a unique
  // constructor per name); subclass so both register cleanly.
  class Stm32BlackPillElement extends Stm32BoardElement {}
  customElements.define('velxio-stm32-blackpill', Stm32BlackPillElement);
}
