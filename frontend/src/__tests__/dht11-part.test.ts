/**
 * dht11-part.test.ts
 *
 * DHT11 — payload packing + waveform scheduling. The DHT11 shares the DHT22
 * wire protocol (ProtocolParts.makeDhtAttachEvents) but packs integer bytes
 * [hum, 0, temp, 0, checksum]. We drive the part's pin-change callback with
 * a mock simulator and decode the schedulePinChange sequence back into bytes.
 */

import { describe, it, expect, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { buildDHT11Payload, buildDHT22Payload } from '../simulation/parts/ProtocolParts';
import '../simulation/parts/ProtocolParts';

const CLOCK_HZ = 16_000_000;
const US = CLOCK_HZ / 1_000_000; // cycles per µs

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

interface Scheduled {
  state: boolean;
  at: number;
}

function makeSimulator() {
  let listener: ((pin: number, state: boolean) => void) | null = null;
  const scheduled: Scheduled[] = [];
  const sim = {
    pinManager: {
      onPinChange: vi.fn((_pin: number, cb: (pin: number, state: boolean) => void) => {
        listener = cb;
        return () => {};
      }),
    },
    setPinState: vi.fn(),
    schedulePinChange: vi.fn((_pin: number, state: boolean, at: number) => {
      scheduled.push({ state, at });
    }),
    getCurrentCycles: () => 0,
    getClockHz: () => CLOCK_HZ,
  };
  return { sim, scheduled, fire: (state: boolean) => listener!(7, state) };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

/** Decode a scheduled DHT waveform (preamble + 40 bits + release) to 5 bytes. */
function decodeWaveform(scheduled: Scheduled[]): number[] {
  // [0]=preamble LOW, [1]=preamble HIGH, then per bit: LOW, HIGH; then final LOW, HIGH.
  expect(scheduled.length).toBe(2 + 40 * 2 + 2);
  const bits: number[] = [];
  for (let i = 0; i < 40; i++) {
    const high = scheduled[3 + 2 * i];
    const nextLow = scheduled[4 + 2 * i];
    expect(high.state).toBe(true);
    expect(nextLow.state).toBe(false);
    const widthUs = (nextLow.at - high.at) / US;
    bits.push(widthUs > 40 ? 1 : 0);
  }
  const bytes: number[] = [];
  for (let i = 0; i < 5; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    bytes.push(b);
  }
  return bytes;
}

describe('buildDHT11Payload', () => {
  it('packs integer bytes [hum, 0, temp, 0, checksum]', () => {
    const el = makeElement({ temperature: 30, humidity: 60 });
    expect(Array.from(buildDHT11Payload(el))).toEqual([60, 0, 30, 0, 90]);
  });

  it('defaults to 25 °C / 50 % when the element has no properties', () => {
    const el = makeElement();
    expect(Array.from(buildDHT11Payload(el))).toEqual([50, 0, 25, 0, 75]);
  });

  it('clamps to the real part range (0–50 °C, 20–90 %RH)', () => {
    const el = makeElement({ temperature: -10, humidity: 99 });
    expect(Array.from(buildDHT11Payload(el))).toEqual([90, 0, 0, 0, 90]);
    const el2 = makeElement({ temperature: 80, humidity: 5 });
    expect(Array.from(buildDHT11Payload(el2))).toEqual([20, 0, 50, 0, 70]);
  });

  it('differs from DHT22 packing (which uses tenths)', () => {
    const el = makeElement({ temperature: 25, humidity: 50 });
    const dht22 = Array.from(buildDHT22Payload(el)); // 250 / 500 in tenths
    expect(dht22).toEqual([(500 >> 8) & 0xff, 500 & 0xff, (250 >> 8) & 0xff, 250 & 0xff, dht22[4]]);
    expect(Array.from(buildDHT11Payload(el))).not.toEqual(dht22);
  });
});

describe('dht11 — attachEvents waveform', () => {
  it('is registered in the PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('dht11')).toBeDefined();
  });

  it('start signal (LOW → HIGH) schedules the 40-bit DHT11 waveform', () => {
    const logic = PartSimulationRegistry.get('dht11')!;
    const { sim, scheduled, fire } = makeSimulator();
    const element = makeElement({ temperature: 31, humidity: 62 });

    const cleanup = logic.attachEvents!(element, sim as any, pinMap({ SDA: 7 }), 'dht11-1');

    // Idle state: line pulled HIGH.
    expect(sim.setPinState).toHaveBeenCalledWith(7, true);

    // MCU start signal: drive LOW, then release HIGH.
    fire(false);
    fire(true);

    expect(decodeWaveform(scheduled)).toEqual([62, 0, 31, 0, 93]);
    cleanup();
  });

  it('delegates to registerSensor("dht11", …) when the simulator handles it natively', () => {
    const logic = PartSimulationRegistry.get('dht11')!;
    const { sim } = makeSimulator();
    const native = {
      ...sim,
      registerSensor: vi.fn().mockReturnValue(true),
      updateSensor: vi.fn(),
      unregisterSensor: vi.fn(),
    };
    const element = makeElement({ temperature: 28, humidity: 40 });

    const cleanup = logic.attachEvents!(element, native as any, pinMap({ SDA: 4 }), 'dht11-2');

    expect(native.registerSensor).toHaveBeenCalledWith('dht11', 4, {
      temperature: 28,
      humidity: 40,
    });
    // No local waveform machinery when the backend owns the protocol.
    expect(native.pinManager.onPinChange).not.toHaveBeenCalled();

    cleanup();
    expect(native.unregisterSensor).toHaveBeenCalledWith(4);
  });
});
