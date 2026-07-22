/**
 * max7219-part.test.ts
 *
 * MAX7219 8×8 dot matrix — decodes the DIN/CLK/CS serial protocol the way
 * LedControl's shiftOut does: drive the mocked pin callbacks with 16-bit
 * words and assert the element's pixels / shutdown / testMode state.
 */

import { describe, it, expect, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/Max7219Part';

const PINS = { DIN: 12, CLK: 11, CS: 10 } as const;

function makeElement(): HTMLElement & { pixels?: Uint8Array; shutdown?: boolean; testMode?: boolean } {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
}

function makeSimulator() {
  const listeners = new Map<number, (pin: number, state: boolean) => void>();
  const sim = {
    pinManager: {
      onPinChange: vi.fn((pin: number, cb: (pin: number, state: boolean) => void) => {
        listeners.set(pin, cb);
        return () => listeners.delete(pin);
      }),
    },
    setPinState: vi.fn(),
  };
  const set = (name: keyof typeof PINS, high: boolean) => listeners.get(PINS[name])?.(PINS[name], high);
  return { sim, set };
}

const pinMap = (name: string): number | null =>
  name in PINS ? PINS[name as keyof typeof PINS] : null;

/** shiftOut MSB-first of a 16-bit (register, data) word inside one CS frame. */
function sendWord(set: (name: keyof typeof PINS, high: boolean) => void, addr: number, data: number) {
  set('CS', false);
  const word = ((addr & 0xff) << 8) | (data & 0xff);
  for (let b = 15; b >= 0; b--) {
    set('DIN', ((word >> b) & 1) === 1);
    set('CLK', true);
    set('CLK', false);
  }
  set('CS', true); // LOAD rising edge latches
}

function attach() {
  const logic = PartSimulationRegistry.get('max7219')!;
  const { sim, set } = makeSimulator();
  const element = makeElement();
  const cleanup = logic.attachEvents!(element, sim as any, pinMap, 'mx1');
  // Start every frame from a known CS-high state.
  set('CS', true);
  return { element, set, cleanup };
}

describe('max7219 — bit-banged protocol', () => {
  it('is registered and powers up shut down with a blank matrix', () => {
    const { element, cleanup } = attach();
    expect(element.shutdown).toBe(true);
    expect(element.testMode).toBe(false);
    expect(Array.from(element.pixels!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    cleanup();
  });

  it('digit register writes update the pixel rows', () => {
    const { element, set, cleanup } = attach();
    sendWord(set, 0x0c, 0x01); // shutdown register → normal operation
    expect(element.shutdown).toBe(false);

    sendWord(set, 0x01, 0b01100110); // row 0
    sendWord(set, 0x08, 0b00011000); // row 7
    expect(element.pixels![0]).toBe(0b01100110);
    expect(element.pixels![7]).toBe(0b00011000);
    // Untouched rows stay blank.
    expect(element.pixels![3]).toBe(0);
    cleanup();
  });

  it('draws a full LedControl-style frame (heart) row by row', () => {
    const HEART = [0x00, 0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18];
    const { element, set, cleanup } = attach();
    sendWord(set, 0x0c, 0x01);
    HEART.forEach((row, i) => sendWord(set, i + 1, row));
    expect(Array.from(element.pixels!)).toEqual(HEART);
    cleanup();
  });

  it('handles shutdown and display-test registers', () => {
    const { element, set, cleanup } = attach();
    sendWord(set, 0x0c, 0x01);
    expect(element.shutdown).toBe(false);
    sendWord(set, 0x0c, 0x00);
    expect(element.shutdown).toBe(true);
    sendWord(set, 0x0f, 0x01);
    expect(element.testMode).toBe(true);
    sendWord(set, 0x0f, 0x00);
    expect(element.testMode).toBe(false);
    cleanup();
  });

  it('ignores clock edges while CS is high and keeps only the last 16 bits', () => {
    const { element, set, cleanup } = attach();
    // Clocking with CS high must not shift anything in.
    set('DIN', true);
    set('CLK', true);
    set('CLK', false);
    sendWord(set, 0x01, 0xaa);
    expect(element.pixels![0]).toBe(0xaa);

    // A frame with more than 16 clocks: only the last 16 bits latch
    // (chained-device behaviour of a single module).
    set('CS', false);
    const word = (0x02 << 8) | 0x55;
    for (let b = 23; b >= 0; b--) {
      set('DIN', b < 16 ? ((word >> b) & 1) === 1 : true);
      set('CLK', true);
      set('CLK', false);
    }
    set('CS', true);
    expect(element.pixels![1]).toBe(0x55);
    cleanup();
  });
});

describe('max7219 — hardware SPI transport', () => {
  it('shifts spi.onByte bytes while CS is low and latches on CS rising', () => {
    const logic = PartSimulationRegistry.get('max7219')!;
    const { sim, set } = makeSimulator();
    const prevOnByte = vi.fn();
    const spi = { onByte: prevOnByte as (b: number) => void, completeTransfer: vi.fn() };
    (sim as any).spi = spi;
    const element = makeElement();
    const cleanup = logic.attachEvents!(element, sim as any, pinMap, 'mx2');
    set('CS', true);

    // CS high → bytes pass through to the previous SPI consumer.
    spi.onByte(0x99);
    expect(prevOnByte).toHaveBeenCalledWith(0x99);

    set('CS', false);
    spi.onByte(0x03); // register: row 2
    spi.onByte(0xf0); // data
    set('CS', true);
    expect(element.pixels![2]).toBe(0xf0);
    expect(spi.completeTransfer).toHaveBeenCalledWith(0x00);

    cleanup();
    // Cleanup restores the previous SPI hook.
    expect(spi.onByte).toBe(prevOnByte);
  });
});
