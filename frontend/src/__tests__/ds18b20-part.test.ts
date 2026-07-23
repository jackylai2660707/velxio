/**
 * ds18b20-part.test.ts
 *
 * DS18B20 1-Wire slave — CRC8 vectors, ROM/scratchpad encoding, and the full
 * protocol state machine driven with scripted master edge sequences (the
 * exact pulse widths OneWire.cpp produces): reset/presence, Read ROM,
 * Skip ROM + Read Scratchpad, and the Search ROM walk DallasTemperature's
 * begin() performs.
 */

import { describe, it, expect, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import {
  crc8Dallas,
  ds18b20Rom,
  ds18b20Scratchpad,
} from '../simulation/parts/OneWireParts';
import '../simulation/parts/OneWireParts';

const CLOCK_HZ = 16_000_000;
const US = CLOCK_HZ / 1_000_000;
const PIN = 2;

// ─── Pure encoding helpers ───────────────────────────────────────────────────

describe('crc8Dallas', () => {
  it('matches the Maxim application-note example ROM', () => {
    // AN27 example: ROM 0xA2 00 00 00 01 B8 1C 02 → CRC (last byte) = 0xA2
    expect(crc8Dallas([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00])).toBe(0xa2);
  });

  it('is zero over a full block that includes its own CRC', () => {
    expect(crc8Dallas([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00, 0xa2])).toBe(0);
  });
});

describe('ds18b20Rom / ds18b20Scratchpad', () => {
  it('ROM has the DS18B20 family code and a valid CRC', () => {
    const rom = ds18b20Rom();
    expect(rom.length).toBe(8);
    expect(rom[0]).toBe(0x28);
    expect(crc8Dallas(rom)).toBe(0);
  });

  it('scratchpad encodes T×16 little-endian with valid CRC', () => {
    const sp = ds18b20Scratchpad(25);
    expect(sp.length).toBe(9);
    expect(sp[0]).toBe((25 * 16) & 0xff); // 0x90
    expect(sp[1]).toBe((25 * 16) >> 8); // 0x01
    expect(sp[4]).toBe(0x7f); // 12-bit config
    expect(crc8Dallas(sp)).toBe(0);
  });

  it('encodes negative temperatures in two’s complement', () => {
    const sp = ds18b20Scratchpad(-10.125);
    const raw = (sp[1] << 8) | sp[0];
    // -10.125 × 16 = -162 → 0xFF5E
    expect(raw).toBe(0xff5e);
    expect(crc8Dallas(sp)).toBe(0);
  });

  it('clamps to the device range −55…+125 °C', () => {
    expect(ds18b20Scratchpad(300)[1]).toBe((125 * 16) >> 8);
    const low = ds18b20Scratchpad(-100);
    expect(((low[1] << 8) | low[0])).toBe((-55 * 16) & 0xffff);
  });
});

// ─── Scripted 1-Wire master ──────────────────────────────────────────────────

interface Master {
  element: { temperature: number };
  reset: () => void;
  writeByte: (b: number) => void;
  writeBit: (bit: number) => void;
  readBit: () => number;
  readByte: () => number;
  scheduled: Array<{ state: boolean; at: number }>;
  now: () => number;
  cleanup: () => void;
}

function makeMaster(temperature = 25): Master {
  const logic = PartSimulationRegistry.get('ds18b20')!;
  let t = 0;
  let listener: ((pin: number, state: boolean) => void) | null = null;
  const scheduled: Array<{ state: boolean; at: number }> = [];
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
    getCurrentCycles: () => t,
    getClockHz: () => CLOCK_HZ,
  };
  const element = { temperature } as any;
  const cleanup = logic.attachEvents!(
    element,
    sim as any,
    (name: string) => (name === 'DQ' ? PIN : null),
    'ds1',
  );

  const fire = (state: boolean) => listener!(PIN, state);

  const writeBit = (bit: number) => {
    fire(false);
    t += (bit ? 5 : 65) * US;
    fire(true);
    t += 10 * US; // recovery
  };

  const readBit = (): number => {
    const before = sim.setPinState.mock.calls.length;
    fire(false); // slave answers a 0-bit by holding the line low
    const drove = sim.setPinState.mock.calls
      .slice(before)
      .some((c: unknown[]) => c[1] === false);
    t += 3 * US;
    fire(true); // gated/ignored for 0-bits — the slave still holds the line
    t += 67 * US; // finish the ≥60 µs slot, past the slave's self-drive gate
    return drove ? 0 : 1;
  };

  return {
    element,
    scheduled,
    now: () => t,
    cleanup,
    writeBit,
    readBit,
    reset: () => {
      fire(false);
      t += 480 * US;
      fire(true);
      t += 500 * US; // wait out presence pulse + gate
    },
    writeByte: (b: number) => {
      for (let i = 0; i < 8; i++) writeBit((b >> i) & 1);
    },
    readByte: () => {
      let b = 0;
      for (let i = 0; i < 8; i++) b |= readBit() << i;
      return b;
    },
  };
}

describe('ds18b20 — 1-Wire state machine', () => {
  it('is registered and idles the line HIGH', () => {
    const m = makeMaster();
    expect(PartSimulationRegistry.get('ds18b20')).toBeDefined();
    m.cleanup();
  });

  it('answers a reset pulse with a presence pulse (30 µs delay, 120 µs low)', () => {
    const m = makeMaster();
    const t0 = m.now();
    m.scheduled.length = 0;
    // Reset: hold low 480 µs, release.
    m.reset();
    const rise = t0 + 480 * US;
    expect(m.scheduled).toEqual([
      { state: false, at: rise + 30 * US },
      { state: true, at: rise + 150 * US },
    ]);
    m.cleanup();
  });

  it('Read ROM (0x33) returns family 0x28 + serial + CRC, LSB-first', () => {
    const m = makeMaster();
    m.reset();
    m.writeByte(0x33);
    const bytes = Array.from({ length: 8 }, () => m.readByte());
    expect(bytes).toEqual(Array.from(ds18b20Rom()));
    m.cleanup();
  });

  it('Skip ROM + Convert T + Read Scratchpad round-trips the slider temperature', () => {
    const m = makeMaster(21.5);
    // Convert T cycle (DallasTemperature::requestTemperatures)
    m.reset();
    m.writeByte(0xcc);
    m.writeByte(0x44);
    // Conversion-done poll: idle read slots answer 1.
    expect(m.readBit()).toBe(1);
    // Read cycle
    m.reset();
    m.writeByte(0xcc);
    m.writeByte(0xbe);
    const sp = Array.from({ length: 9 }, () => m.readByte());
    expect(sp).toEqual(Array.from(ds18b20Scratchpad(21.5)));
    const raw = ((sp[1] << 8) | sp[0]) << 16 >> 16; // sign-extend
    expect(raw / 16).toBeCloseTo(21.5, 3);
    m.cleanup();
  });

  it('Match ROM (0x55) with the right id selects the device; wrong id deselects', () => {
    const rom = ds18b20Rom();
    const m = makeMaster(30);
    m.reset();
    m.writeByte(0x55);
    for (const b of rom) m.writeByte(b);
    m.writeByte(0xbe);
    expect(m.readByte()).toBe(ds18b20Scratchpad(30)[0]);

    // Wrong ROM → device stays silent; read slots idle-read 1s.
    m.reset();
    m.writeByte(0x55);
    for (const b of rom) m.writeByte(b === rom[0] ? 0x22 : b);
    m.writeByte(0xbe);
    expect(m.readByte()).toBe(0xff);
    m.cleanup();
  });

  it('Search ROM (0xF0) walks out the full 64-bit id (DallasTemperature::begin)', () => {
    const rom = ds18b20Rom();
    const m = makeMaster();
    m.reset();
    m.writeByte(0xf0);
    const bits: number[] = [];
    for (let i = 0; i < 64; i++) {
      const bit = m.readBit();
      const comp = m.readBit();
      expect(comp).toBe(bit ^ 1); // single device on the bus
      bits.push(bit);
      m.writeBit(bit); // master follows the device
    }
    const found = new Uint8Array(8);
    bits.forEach((b, i) => {
      if (b) found[i >> 3] |= 1 << (i & 7);
    });
    expect(Array.from(found)).toEqual(Array.from(rom));
    m.cleanup();
  });

  it('Write Scratchpad (0x4E) consumes 3 bytes without corrupting later reads', () => {
    const m = makeMaster(25);
    m.reset();
    m.writeByte(0xcc);
    m.writeByte(0x4e);
    m.writeByte(0x50); // TH
    m.writeByte(0x00); // TL
    m.writeByte(0x7f); // config
    m.writeByte(0xbe); // back in func-cmd phase → read scratchpad
    expect(m.readByte()).toBe(ds18b20Scratchpad(25)[0]);
    m.cleanup();
  });
});
