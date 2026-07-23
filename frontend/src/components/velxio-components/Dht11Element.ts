/**
 * Dht11Element.ts — DHT11 temperature/humidity sensor (velxio-native).
 *
 * The staple first sensor of Chinese-market Arduino starter kits.
 * wokwi-elements ships only the DHT22, so we draw our own: the classic blue
 * perforated cuboid on four legs. Pin layout intentionally mirrors the
 * wokwi DHT22 (VCC / SDA / NC / GND along the bottom, same spacing) so
 * wiring diagrams transfer between the two parts 1:1.
 *
 * Protocol simulation lives in simulation/parts/ProtocolParts.ts under
 * metadataId 'dht11' (same single-wire protocol as DHT22, integer payload).
 */

const PIN_Y = 114.9;

const PIN_INFO = [
  { name: 'VCC', x: 15, y: PIN_Y, number: 1, signals: [{ type: 'power', signal: 'VCC' }] },
  { name: 'SDA', x: 24.5, y: PIN_Y, number: 2, signals: [] as Array<unknown> },
  { name: 'NC', x: 34.1, y: PIN_Y, number: 3, signals: [] as Array<unknown> },
  { name: 'GND', x: 43.8, y: PIN_Y, number: 4, signals: [{ type: 'power', signal: 'GND' }] },
];

class Dht11Element extends HTMLElement {
  readonly pinInfo = PIN_INFO;

  // Live sensor values — read by the part simulation when building frames.
  // Coercing setters mirror lit's `@property({type: Number})` on wokwi
  // elements: example properties and the property dialog deliver strings,
  // and a string forwarded to the ESP32 backend crashes the worker's
  // payload builder.
  private _temperature = 25;
  private _humidity = 50;

  get temperature(): number {
    return this._temperature;
  }
  set temperature(v: number | string) {
    const n = Number(v);
    if (!Number.isNaN(n)) this._temperature = n;
  }

  get humidity(): number {
    return this._humidity;
  }
  set humidity(v: number | string) {
    const n = Number(v);
    if (!Number.isNaN(n)) this._humidity = n;
  }

  constructor() {
    super();
    const holes: string[] = [];
    // 4×5 grid of vent holes on the face — the DHT11's signature look
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 4; col++) {
        holes.push(
          `<circle cx="${14.5 + col * 10}" cy="${18 + row * 13}" r="3.1" fill="#0f2e63" />`,
        );
      }
    }
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg   { display: block; overflow: visible; }
        .pin-label {
          font: 600 5.5px monospace;
          fill: #333;
          text-anchor: middle;
          pointer-events: none;
        }
      </style>
      <svg width="59" height="120" viewBox="0 0 59 120">
        <!-- legs -->
        <rect x="13.6" y="92" width="2.8" height="23" fill="#9aa2ab" />
        <rect x="23.1" y="92" width="2.8" height="23" fill="#9aa2ab" />
        <rect x="32.7" y="92" width="2.8" height="23" fill="#9aa2ab" />
        <rect x="42.4" y="92" width="2.8" height="23" fill="#9aa2ab" />
        <!-- blue body -->
        <rect x="4" y="2" width="51" height="92" rx="4" fill="#2a6bd6" />
        <rect x="4" y="2" width="51" height="92" rx="4" fill="none" stroke="#1c4c9c" stroke-width="1.5" />
        ${holes.join('\n        ')}
        <text x="29.5" y="90" text-anchor="middle" font-family="monospace" font-size="7" fill="#dce8ff">DHT11</text>
        <!-- pin labels -->
        <text class="pin-label" x="15"   y="105">+</text>
        <text class="pin-label" x="24.5" y="105">S</text>
        <text class="pin-label" x="43.8" y="105">−</text>
      </svg>`;
  }
}

if (!customElements.get('velxio-dht11')) {
  customElements.define('velxio-dht11', Dht11Element);
}
