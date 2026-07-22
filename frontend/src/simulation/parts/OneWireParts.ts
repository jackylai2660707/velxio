/**
 * 1-Wire slave devices — currently the DS18B20 temperature sensor.
 *
 * Implements a single-device 1-Wire slave at the pin-waveform level against
 * the Arduino OneWire/DallasTemperature libraries:
 *
 *   reset      master holds DQ low ≥480 µs → we answer with a presence
 *              pulse (30 µs after release, low for 120 µs)
 *   write slot master low-pulse width decides the bit: <15 µs = 1, ≥15 = 0
 *              (bits arrive LSB-first)
 *   read slot  master pulls low ~3 µs; if our next bit is 0 we hold the
 *              line low for ~45 µs (schedulePinChange), else stay released
 *
 * Supported ROM commands: 0x33 Read ROM, 0xCC Skip ROM, 0x55 Match ROM,
 * 0xF0 Search ROM (single device — required by DallasTemperature::begin).
 * Function commands: 0x44 Convert T (instant; poll slots read 1 = done),
 * 0xBE Read Scratchpad (9 bytes incl. CRC8), 0x4E Write Scratchpad
 * (3 bytes consumed), 0xB4 Read Power Supply (idle read = 1 = external).
 *
 * Requires cycle-accurate pin scheduling (schedulePinChange) — available on
 * AVR and RP2040. On ESP32 the part is inert for now (the QEMU worker would
 * have to own the protocol, as it does for DHT); the catalog description
 * says so.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';

/** Dallas/Maxim CRC8 (poly 0x8C, LSB-first) — used by ROM ids and scratchpads. */
export function crc8Dallas(data: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    let inbyte = data[i];
    for (let b = 0; b < 8; b++) {
      const mix = (crc ^ inbyte) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      inbyte >>= 1;
    }
  }
  return crc;
}

/** Fixed 64-bit ROM id: family 0x28 (DS18B20) + "VELXIO" serial + CRC. */
export function ds18b20Rom(): Uint8Array {
  const rom = new Uint8Array(8);
  rom[0] = 0x28;
  rom.set([0x56, 0x45, 0x4c, 0x58, 0x49, 0x4f], 1); // "VELXIO"
  rom[7] = crc8Dallas(rom.subarray(0, 7));
  return rom;
}

/** 9-byte scratchpad for a temperature in °C (raw = T × 16, 12-bit mode). */
export function ds18b20Scratchpad(temperatureC: number): Uint8Array {
  const clamped = Math.min(125, Math.max(-55, temperatureC));
  const raw = Math.round(clamped * 16) & 0xffff;
  const sp = new Uint8Array(9);
  sp[0] = raw & 0xff;
  sp[1] = (raw >> 8) & 0xff;
  sp[2] = 0x4b; // TH
  sp[3] = 0x46; // TL
  sp[4] = 0x7f; // config: 12-bit
  sp[5] = 0xff;
  sp[6] = 0x0c;
  sp[7] = 0x10;
  sp[8] = crc8Dallas(sp.subarray(0, 8));
  return sp;
}

type Phase = 'idle' | 'rom-cmd' | 'match-rom' | 'search' | 'func-cmd' | 'write-scratch';

PartSimulationRegistry.register('ds18b20', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const el = element as any;
    const sim = simulator as any;
    const pin = getPin('DQ') ?? getPin('DATA');
    if (pin === null) return () => {};

    // Cycle-accurate scheduling is required for 1-Wire slot timing.
    if (typeof sim.schedulePinChange !== 'function' || typeof sim.getCurrentCycles !== 'function') {
      // ESP32 / legacy simulators: keep the control panel responsive so the
      // student's slider still updates the element, but the wire is inert.
      registerSensorUpdate(componentId, (values) => {
        if ('temperature' in values) el.temperature = values.temperature as number;
      });
      return () => unregisterSensorUpdate(componentId);
    }

    const clockHz: number = typeof sim.getClockHz === 'function' ? sim.getClockHz() : 16_000_000;
    const us = (microseconds: number) => Math.round((microseconds * clockHz) / 1_000_000);
    const toUs = (cycles: number) => (cycles * 1_000_000) / clockHz;

    const rom = ds18b20Rom();

    // ── Protocol state ────────────────────────────────────────────────────
    let phase: Phase = 'idle';
    let lowStartCycle = -1;
    /** Bits queued for the master to read (consumed one per read slot). */
    let txBits: number[] = [];
    /** True while the current low phase is a slot we are answering. */
    let slotWasTx = false;
    /** Ignore our own scheduled edges until this cycle. */
    let selfDriveGate = 0;
    // Receive accumulator (LSB-first)
    let rxByte = 0;
    let rxCount = 0;
    let rxBytesLeft = 0; // for multi-byte consumers (match-rom, write-scratch)
    let matchIndex = 0;
    let matchOk = true;
    let searchBit = 0;

    const queueBytes = (bytes: ArrayLike<number>) => {
      for (let i = 0; i < bytes.length; i++) {
        for (let b = 0; b < 8; b++) txBits.push((bytes[i] >> b) & 1); // LSB first
      }
    };

    const resetReceiver = () => {
      rxByte = 0;
      rxCount = 0;
    };

    const onBitReceived = (bit: number) => {
      if (phase === 'search') {
        // Master wrote its direction choice — stay only if it matches our bit.
        const ourBit = (rom[searchBit >> 3] >> (searchBit & 7)) & 1;
        if (bit !== ourBit) {
          phase = 'idle';
          txBits = [];
          return;
        }
        searchBit++;
        if (searchBit >= 64) {
          phase = 'idle'; // search complete; master resets before commands
        } else {
          const next = (rom[searchBit >> 3] >> (searchBit & 7)) & 1;
          txBits.push(next, next ^ 1);
        }
        return;
      }

      rxByte |= bit << rxCount;
      rxCount++;
      if (rxCount < 8) return;
      const byte = rxByte;
      resetReceiver();
      onByteReceived(byte);
    };

    const onByteReceived = (byte: number) => {
      switch (phase) {
        case 'rom-cmd':
          if (byte === 0xcc) {
            phase = 'func-cmd'; // Skip ROM
          } else if (byte === 0x33) {
            queueBytes(rom); // Read ROM
            phase = 'func-cmd';
          } else if (byte === 0x55) {
            phase = 'match-rom';
            rxBytesLeft = 8;
            matchIndex = 0;
            matchOk = true;
          } else if (byte === 0xf0 || byte === 0xec) {
            phase = 'search';
            searchBit = 0;
            const first = rom[0] & 1;
            txBits.push(first, first ^ 1);
          } else {
            phase = 'idle';
          }
          break;

        case 'match-rom':
          if (byte !== rom[matchIndex]) matchOk = false;
          matchIndex++;
          rxBytesLeft--;
          if (rxBytesLeft === 0) phase = matchOk ? 'func-cmd' : 'idle';
          break;

        case 'func-cmd':
          if (byte === 0xbe) {
            // Read Scratchpad — temperature snapshot at read time
            queueBytes(ds18b20Scratchpad(el.temperature ?? 25));
          } else if (byte === 0x4e) {
            phase = 'write-scratch';
            rxBytesLeft = 3;
          }
          // 0x44 Convert T: instant — subsequent poll read-slots idle-read 1
          // ("conversion done"). 0x48/0xB8/0xB4: nothing to do.
          break;

        case 'write-scratch':
          rxBytesLeft--;
          if (rxBytesLeft === 0) phase = 'func-cmd';
          break;

        default:
          break;
      }
    };

    const unsub = sim.pinManager.onPinChange(pin, (_: number, state: boolean) => {
      const now = sim.getCurrentCycles() as number;
      if (now < selfDriveGate) return; // our own scheduled edge

      if (!state) {
        // Falling edge: slot start (or reset start).
        lowStartCycle = now;
        slotWasTx = false;
        if (txBits.length > 0) {
          slotWasTx = true;
          const bit = txBits.shift()!;
          if (bit === 0) {
            // Hold the line low for the master's sample window.
            sim.setPinState(pin, false);
            const releaseAt = now + us(45);
            sim.schedulePinChange(pin, true, releaseAt);
            selfDriveGate = releaseAt + us(3);
          }
        }
        return;
      }

      // Rising edge: measure the low pulse.
      if (lowStartCycle < 0) return;
      const lowUs = toUs(now - lowStartCycle);
      lowStartCycle = -1;

      if (lowUs >= 240) {
        // Reset pulse → presence response, protocol restarts.
        txBits = [];
        resetReceiver();
        phase = 'rom-cmd';
        const presenceStart = now + us(30);
        const presenceEnd = presenceStart + us(120);
        sim.schedulePinChange(pin, false, presenceStart);
        sim.schedulePinChange(pin, true, presenceEnd);
        selfDriveGate = presenceEnd + us(3);
        return;
      }

      if (slotWasTx) {
        slotWasTx = false;
        return; // read slot — nothing to decode
      }
      if (phase === 'idle') return;
      onBitReceived(lowUs < 15 ? 1 : 0);
    });

    // Idle line state: pulled up HIGH.
    sim.setPinState(pin, true);

    registerSensorUpdate(componentId, (values) => {
      if ('temperature' in values) el.temperature = values.temperature as number;
    });

    return () => {
      unsub();
      sim.setPinState(pin, true);
      unregisterSensorUpdate(componentId);
    };
  },
});
