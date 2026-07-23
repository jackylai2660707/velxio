/**
 * Wire signal classification for the agent's add_wire tool.
 *
 * Behavior-tested design (see docs/wiki/ai-assistant.md): the model keeps
 * full color freedom — this only supplies the STANDARD color when the model
 * omits `color`, and always derives `Wire.signalType` so the existing
 * WIRE_COLORS convention (utils/wireColors.ts) finally reaches agent-drawn
 * wires. Classification prefers pinInfo `signals` metadata (wokwi elements
 * ship it); custom velxio elements without signals fall back to pin names.
 */

import { determineSignalType } from '../utils/wireColors';
import type { WireSignalType } from '../types/wire';

/** Higher = more specific; the more specific endpoint wins. */
const SPECIFICITY: Record<WireSignalType, number> = {
  'power-vcc': 6,
  'power-gnd': 6,
  i2c: 5,
  spi: 5,
  usart: 5,
  pwm: 3,
  analog: 2,
  digital: 1,
};

export interface ClassifiablePin {
  name: string;
  description?: string;
  signals?: unknown[];
}

/** Name/description-based fallback for pins without `signals` metadata. */
export function classifyByPinName(name: string, description = ''): WireSignalType | null {
  const n = name.toUpperCase();
  const d = description.toUpperCase();
  if (n.startsWith('GND')) return 'power-gnd';
  if (/^(VCC|5V|3V3|3\.3V|VIN|VBUS|VDD|PWR)(\.\d+)?$/.test(n)) return 'power-vcc';
  if (/^(SDA|SCL)\d*$/.test(n) || /\b(SDA|SCL)\b/.test(d)) return 'i2c';
  if (/^(MOSI|MISO|SCK|SCLK|CS|SS)\d*$/.test(n)) return 'spi';
  if (/^(TX|RX)D?\d*$/.test(n)) return 'usart';
  if (/^A\d+$/.test(n)) return 'analog';
  return null;
}

function classifyEndpoint(pins: ClassifiablePin[] | null, pinName: string): WireSignalType | null {
  const pin = pins?.find((p) => p.name === pinName || p.name === `${pinName}.1`);
  if (pin?.signals && Array.isArray(pin.signals) && pin.signals.length > 0) {
    return determineSignalType(pin.signals);
  }
  return classifyByPinName(pinName, pin?.description ?? '');
}

/**
 * Classify a wire from its two endpoints. The more specific endpoint wins
 * (a GND pin wired to digital pin 13 is a ground wire). Defaults to
 * 'digital' when neither endpoint gives a clue.
 */
export function classifyWire(
  startPins: ClassifiablePin[] | null,
  startPin: string,
  endPins: ClassifiablePin[] | null,
  endPin: string,
): WireSignalType {
  const a = classifyEndpoint(startPins, startPin);
  const b = classifyEndpoint(endPins, endPin);
  if (a && b) return SPECIFICITY[a] >= SPECIFICITY[b] ? a : b;
  return a ?? b ?? 'digital';
}
