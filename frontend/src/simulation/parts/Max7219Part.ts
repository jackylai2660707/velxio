/**
 * MAX7219 8×8 dot-matrix — protocol simulation.
 *
 * Decodes the 3-wire serial interface (DIN/CLK/CS) the way the chip does:
 * bits shift in on CLK rising edges, and the last 16 bits shifted are
 * latched as a (register, data) word on the CS/LOAD rising edge. Register
 * map (the subset LedControl / MD_MAX72XX exercise):
 *   0x01-0x08 digit rows  → element.pixels row bitmaps
 *   0x09 decode mode      (ignored — matrix modules use no-decode)
 *   0x0A intensity        (visual only, currently ignored)
 *   0x0B scan limit       (ignored — all 8 rows always shown)
 *   0x0C shutdown         → element.shutdown (0 = shutdown/blank)
 *   0x0F display test     → element.testMode (1 = all dots on)
 *
 * Works for BOTH transports:
 *  - bit-banged shiftOut (what LedControl always does) — decoded from pin
 *    edges via the 74HC595 pinSub pattern;
 *  - hardware SPI — `simulator.spi.onByte` bytes are shifted into the same
 *    16-bit register while CS is low (SPI.transfer shifts MSB-first, same
 *    as the pin-level model), so the CS-latch logic is shared.
 *
 * Edge-triggered logic with no µs timing → works on AVR, RP2040 and the
 * ESP32 pin-event bridge alike.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';

PartSimulationRegistry.register('max7219', {
  attachEvents: (element, simulator, getArduinoPinHelper, _componentId, getPinResolver) => {
    const el = element as any;
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    // ── Chip state ────────────────────────────────────────────────────────
    let shiftReg = 0; // 16-bit shift register (last 16 bits win)
    let dinHigh = false;
    let prevClk = false;
    let prevCs = true;
    let csLow = false;
    const pixels = new Uint8Array(8);

    const sync = () => {
      // Assign a copy so the element setter always sees a fresh reference.
      el.pixels = Uint8Array.from(pixels);
    };

    const latch = () => {
      const addr = (shiftReg >> 8) & 0x0f;
      const data = shiftReg & 0xff;
      if (addr >= 0x01 && addr <= 0x08) {
        pixels[addr - 1] = data;
        sync();
      } else if (addr === 0x0c) {
        el.shutdown = data === 0;
      } else if (addr === 0x0f) {
        el.testMode = data !== 0;
      }
      // 0x00 no-op, 0x09 decode, 0x0A intensity, 0x0B scan limit: ignored
    };

    // ── Pin subscriptions (74HC595 pattern) ───────────────────────────────
    const useResolver = typeof getPinResolver === 'function';
    function onHighLow(name: string, cb: (high: boolean) => void): (() => void) | null {
      if (useResolver) {
        const r = getPinResolver!(name);
        if (r) return r.onChange((state: string) => cb(state === 'HIGH'));
      }
      const pin = getArduinoPinHelper(name);
      if (pin === null) return null;
      return pinManager.onPinChange(pin, (_: number, s: boolean) => cb(s));
    }

    const unsubs: (() => void)[] = [];
    const sub = (name: string, cb: (high: boolean) => void) => {
      const u = onHighLow(name, cb);
      if (u) unsubs.push(u);
      return u !== null;
    };

    sub('DIN', (high) => {
      dinHigh = high;
    });
    sub('CLK', (high) => {
      if (high && !prevClk && csLow) {
        shiftReg = ((shiftReg << 1) | (dinHigh ? 1 : 0)) & 0xffff;
      }
      prevClk = high;
    });
    sub('CS', (high) => {
      if (high && !prevCs) latch(); // LOAD rising edge
      csLow = !high;
      if (csLow) shiftReg = 0; // fresh word per CS frame
      prevCs = high;
    });

    // ── Hardware-SPI transport (ili9341 pattern) ──────────────────────────
    const spi = (simulator as any).spi;
    let prevOnByte: ((b: number) => void) | null = null;
    if (spi && typeof spi.onByte !== 'undefined') {
      prevOnByte = spi.onByte;
      spi.onByte = (mosi: number) => {
        if (csLow) {
          shiftReg = ((shiftReg << 8) | (mosi & 0xff)) & 0xffff;
        } else {
          prevOnByte?.(mosi);
          return;
        }
        spi.completeTransfer?.(0x00);
      };
    }

    // Reset the visual to power-on state
    pixels.fill(0);
    el.shutdown = true;
    el.testMode = false;
    sync();

    return () => {
      for (const u of unsubs) u();
      if (spi && prevOnByte !== null) spi.onByte = prevOnByte;
    };
  },
});
