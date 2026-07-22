/**
 * Ds18b20Element.ts — DS18B20 1-Wire temperature sensor (velxio-native).
 *
 * TO-92 package, flat face forward, three legs: GND / DQ / VDD (left to
 * right looking at the flat face — the orientation every wiring diagram
 * uses). The 1-Wire slave protocol lives in
 * simulation/parts/OneWireParts.ts under metadataId 'ds18b20'.
 */

const PIN_Y = 92;

const PIN_INFO = [
  { name: 'GND', x: 14, y: PIN_Y, number: 1, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'DQ', x: 30, y: PIN_Y, number: 2, signals: [] as Array<unknown> },
  { name: 'VDD', x: 46, y: PIN_Y, number: 3, signals: [{ type: 'power', signal: 'VCC' }] },
];

class Ds18b20Element extends HTMLElement {
  readonly pinInfo = PIN_INFO;

  /** Live temperature — read by the 1-Wire part simulation (°C) */
  temperature = 25;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg   { display: block; overflow: visible; }
        .pin-label { font: 600 6px monospace; fill: #444; text-anchor: middle; pointer-events: none; }
      </style>
      <svg width="60" height="96" viewBox="0 0 60 96">
        <!-- legs -->
        <rect x="12.6" y="52" width="2.8" height="38" fill="#9aa2ab" />
        <rect x="28.6" y="52" width="2.8" height="38" fill="#9aa2ab" />
        <rect x="44.6" y="52" width="2.8" height="38" fill="#9aa2ab" />
        <!-- TO-92 body: half-round with flat face toward the viewer -->
        <path d="M 8 52 L 8 34 A 22 22 0 0 1 52 34 L 52 52 Z" fill="#1d1d1f" />
        <path d="M 8 52 L 8 34 A 22 22 0 0 1 52 34 L 52 52 Z" fill="none" stroke="#3a3a3e" stroke-width="1.5" />
        <text x="30" y="42" text-anchor="middle" font-family="monospace" font-size="6" fill="#c9c9cf">DS18B20</text>
        <!-- pin labels -->
        <text class="pin-label" x="14" y="62">G</text>
        <text class="pin-label" x="30" y="62">DQ</text>
        <text class="pin-label" x="46" y="62">V</text>
      </svg>`;
  }
}

if (!customElements.get('velxio-ds18b20')) {
  customElements.define('velxio-ds18b20', Ds18b20Element);
}
