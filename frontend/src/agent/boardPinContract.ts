/**
 * Conservative board-level electrical/pin contract for the agent.
 *
 * `pinInfo` tells us what a rendered board calls a pad.  It does not tell the
 * agent whether that pad is safe to drive, is shared with flash/USB, or is a
 * boot strapping pin.  This module fills that gap without touching the
 * simulator.  It is deliberately data-only and deterministic so callers can
 * use it in prompts, wiring lint, and pre-flight validation.
 *
 * The contract describes common carrier boards shipped by Velxio, not every
 * breakout board on the market.  Unknown boards/pins return `null`; callers
 * should then remain fail-closed instead of guessing a GPIO number.
 */

import { getEsp32Capabilities } from './esp32Capabilities';

export type PinProtocol = string;

export type PinPowerRole = 'gnd' | '3v3' | '5v' | 'vin' | 'reset' | 'reference';

export interface BoardPinContract {
  /** Board kind this record belongs to. */
  boardKind: string;
  /** Canonical physical/silkscreen name. */
  name: string;
  /** Numeric GPIO/pin number when this is a MCU GPIO. */
  gpio?: number;
  /** Alternate names accepted by the rendered board and code examples. */
  aliases: readonly string[];
  /** True when the pad is present on the supported carrier's header/art. */
  exposed: boolean;
  /** Connected to flash/PSRAM/USB/JTAG or otherwise not a general-purpose pad. */
  reserved: boolean;
  /** Changes boot/strapping behaviour on common boards. */
  strap: boolean;
  /** Silicon cannot source output (for example ESP32 GPIO34-39). */
  inputOnly: boolean;
  /** Nominal logic/power voltage. `null` means a power input or ground rail. */
  voltage: 3.3 | 5 | null;
  /** Hardware/function hints. Matrix-routable functions are labelled as such. */
  protocols: readonly PinProtocol[];
  /** Ground, supply, reset and reference rails are not GPIOs. */
  powerRole?: PinPowerRole;
  /** Human-readable reason an agent should be cautious. */
  notes: readonly string[];
}

export interface PinValidation {
  ok: boolean;
  pin: BoardPinContract | null;
  errors: string[];
  warnings: string[];
}

export type PinUse = 'wire' | 'input' | 'output' | 'analog';

type MutablePin = Omit<BoardPinContract, 'aliases' | 'protocols' | 'notes'> & {
  aliases: string[];
  protocols: string[];
  notes: string[];
};

const clone = (pin: MutablePin): BoardPinContract => ({
  ...pin,
  aliases: [...pin.aliases],
  protocols: [...pin.protocols],
  notes: [...pin.notes],
});

const gpio = (
  boardKind: string,
  name: string,
  number: number,
  options: Partial<Pick<MutablePin, 'aliases' | 'reserved' | 'strap' | 'inputOnly' | 'protocols' | 'notes' | 'exposed' | 'voltage'>> = {},
): MutablePin => ({
  boardKind,
  name,
  gpio: number,
  aliases: [],
  exposed: true,
  reserved: false,
  strap: false,
  inputOnly: false,
  voltage: options.voltage ?? 3.3,
  protocols: [],
  notes: [],
  ...options,
});

const rail = (
  boardKind: string,
  name: string,
  powerRole: PinPowerRole,
  voltage: 3.3 | 5 | null,
  options: Partial<Pick<MutablePin, 'aliases' | 'reserved' | 'strap' | 'inputOnly' | 'notes' | 'exposed'>> = {},
): MutablePin => ({
  boardKind,
  name,
  aliases: [],
  exposed: true,
  reserved: false,
  strap: false,
  inputOnly: true,
  voltage,
  protocols: ['power'],
  powerRole,
  notes: [],
  ...options,
});

function addAlias(pin: MutablePin, ...aliases: string[]): MutablePin {
  pin.aliases.push(...aliases.filter((alias) => alias && alias !== pin.name));
  return pin;
}

function addProtocol(pin: MutablePin, ...protocols: string[]): MutablePin {
  pin.protocols.push(...protocols);
  return pin;
}

function addNote(pin: MutablePin, ...notes: string[]): MutablePin {
  pin.notes.push(...notes);
  return pin;
}

const CLASSIC_ESP32_EXPOSED = new Set([
  0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27,
  32, 33, 34, 35, 36, 39,
]);

const ESP32_CAM_EXPOSED = new Set([0, 1, 2, 3, 4, 12, 13, 14, 15, 16]);

const S3_EXPOSED = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
]);

const C3_EXPOSED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21]);

function classicEsp32(kind: string): MutablePin[] {
  const pins: MutablePin[] = [];
  const exposed = kind === 'esp32-cam' ? ESP32_CAM_EXPOSED : CLASSIC_ESP32_EXPOSED;
  const useGpioLabels = kind === 'wemos-lolin32-lite' || kind === 'm5stack-core';
  for (let n = 0; n <= 39; n++) {
    const isFlash = n >= 6 && n <= 11;
    const p = gpio(kind, useGpioLabels ? `GPIO${n}` : String(n), n, {
      exposed: exposed.has(n),
      reserved: isFlash,
      inputOnly: n >= 34,
      strap: [0, 2, 5, 12, 15].includes(n),
    });
    if (!useGpioLabels) addAlias(p, `GPIO${n}`, `D${n}`);
    else addAlias(p, String(n), `D${n}`);
    if (kind === 'esp32-devkit-c-v4' && n === 6) addAlias(p, 'CLK');
    if (kind === 'esp32-devkit-c-v4' && n === 11) addAlias(p, 'CMD');
    if (n === 1) addAlias(p, 'TX', 'TX0', 'TXD', 'TXD0');
    if (n === 3) addAlias(p, 'RX', 'RX0', 'RXD', 'RXD0');
    if (n === 16) addAlias(p, 'RX2', 'RXD2');
    if (n === 17) addAlias(p, 'TX2', 'TXD2');
    if (n === 36) addAlias(p, 'VP');
    if (n === 39) addAlias(p, 'VN');
    if (n === 1) addProtocol(p, 'uart0-tx');
    if (n === 3) addProtocol(p, 'uart0-rx');
    if (n === 17) addProtocol(p, 'uart2-tx');
    if (n === 16) addProtocol(p, 'uart2-rx');
    if (n === 21) addProtocol(p, 'i2c0-sda (default)');
    if (n === 22) addProtocol(p, 'i2c0-scl (default)');
    if (n === 23) addProtocol(p, 'spi-vspi-mosi');
    if (n === 19) addProtocol(p, 'spi-vspi-miso');
    if (n === 18) addProtocol(p, 'spi-vspi-sck');
    if (n === 5) addProtocol(p, 'spi-vspi-cs');
    if (n >= 32 && n <= 39) addProtocol(p, 'adc1');
    if ([0, 2, 4, 12, 13, 14, 15, 25, 26, 27].includes(n)) addProtocol(p, 'adc2');
    if (!p.inputOnly && !p.reserved) addProtocol(p, 'pwm-ledc');
    if (isFlash) addNote(p, 'SPI flash connection; do not use as a GPIO');
    if (n >= 34) addNote(p, 'input-only; no digital output or internal pull-up');
    if (p.strap) addNote(p, 'boot strapping pin; external pull resistors can change boot mode');
    if (n === 12) addNote(p, 'strapping pin also selects flash voltage on classic modules');
    if ([0, 2, 4, 12, 13, 14, 15, 25, 26, 27].includes(n)) {
      addNote(p, 'ADC2 is unavailable while WiFi is active');
    }
    pins.push(p);
  }
  pins.push(rail(kind, 'GND', 'gnd', null, { aliases: ['GND.1', 'GND.2', 'GND.3'] }));
  pins.push(rail(kind, '3V3', '3v3', 3.3, { aliases: ['3V3.1', '3V3.2'] }));
  pins.push(rail(kind, '5V', '5v', 5, { aliases: ['VIN', 'VCC'], notes: ['5V rail/input; never connect directly to a 3.3V GPIO'] }));
  pins.push(rail(kind, 'EN', 'reset', 3.3, { reserved: true, notes: ['active-low reset/enable; do not drive as ordinary GPIO'] }));
  pins.push(rail(kind, 'RST', 'reset', 3.3, { reserved: true, notes: ['reset input; do not drive as ordinary GPIO'] }));
  return pins;
}

function esp32S3(kind: string): MutablePin[] {
  // Carrier labels differ: DevKitC uses bare GPIO numbers, XIAO/Nano use Dn.
  const pins: MutablePin[] = [];
  const xiao = kind === 'xiao-esp32-s3';
  const nano = kind === 'arduino-nano-esp32';
  const labels: Record<number, string> = xiao
    ? { 1: 'D0', 2: 'D1', 3: 'D2', 4: 'D3', 5: 'D4', 6: 'D5', 43: 'D6', 44: 'D7', 7: 'D8', 8: 'D9', 9: 'D10' }
    : nano
      ? { 44: 'RX0', 43: 'TX1', 5: 'D2', 6: 'D3', 7: 'D4', 8: 'D5', 9: 'D6', 10: 'D7', 17: 'D8', 18: 'D9', 21: 'D10' }
      : {};
  for (let n = 0; n <= 48; n++) {
    const isHiddenMemory = n >= 22 && n <= 34;
    const p = gpio(kind, labels[n] ?? String(n), n, {
      exposed: S3_EXPOSED.has(n),
      reserved: isHiddenMemory,
      inputOnly: n === 46 || (n >= 34 && n <= 39),
      strap: [0, 3, 45, 46].includes(n),
    });
    addAlias(p, `GPIO${n}`);
    if (labels[n]) addAlias(p, String(n), `GPIO${n}`);
    if (nano && n === 44) addAlias(p, 'D0');
    if (nano && n === 43) addAlias(p, 'D1');
    if (nano) {
      const nanoAliases: Record<number, string[]> = {
        47: ['D12'], 48: ['D13'], 5: ['D2'], 6: ['D3'], 7: ['D4'],
        8: ['D5'], 9: ['D6'], 10: ['D7'], 17: ['D8'], 18: ['D9'], 21: ['D10'],
        1: ['A0'], 2: ['A1'], 3: ['A2'], 4: ['A3'], 11: ['A4'], 12: ['A5'],
        13: ['A6'], 14: ['A7'], 46: ['B0'], 0: ['B1'],
      };
      if (nanoAliases[n]) addAlias(p, ...nanoAliases[n]);
    }
    if (n === 43) addAlias(p, 'TX', 'TX0', 'TXD');
    if (n === 44) addAlias(p, 'RX', 'RX0', 'RXD');
    if (n === 43) addProtocol(p, 'uart0-tx');
    if (n === 44) addProtocol(p, 'uart0-rx');
    if (n === 17) addProtocol(p, 'uart1-tx');
    if (n === 18) addProtocol(p, 'uart1-rx');
    if (n === 8) addProtocol(p, 'i2c0-sda (default)');
    if (n === 9) addProtocol(p, 'i2c0-scl (default)');
    if (n >= 1 && n <= 10) addProtocol(p, 'adc1');
    if (!p.inputOnly && !p.reserved) addProtocol(p, 'pwm-ledc');
    if (n >= 34 && n <= 39) addNote(p, 'input-only on ESP32-S3');
    if (n === 46) addNote(p, 'input-only strapping pin');
    if (p.strap) addNote(p, 'boot strapping pin; verify pull resistors before wiring');
    if (n === 19 || n === 20) addNote(p, 'native USB D-/D+; avoid if USB/JTAG is in use');
    if (isHiddenMemory) addNote(p, 'reserved for flash/PSRAM on common S3 modules');
    pins.push(p);
  }
  pins.push(rail(kind, 'GND', 'gnd', null, { aliases: ['GND.1', 'GND.2', 'GND.3', 'GND.4'] }));
  pins.push(rail(kind, '3V3', '3v3', 3.3, { aliases: ['3V3.1', '3V3.2'] }));
  pins.push(rail(kind, '5V', '5v', 5, { aliases: ['VIN', 'VBUS'] }));
  pins.push(rail(kind, 'RST', 'reset', 3.3, { reserved: true, aliases: ['EN'], notes: ['reset/enable; do not drive as ordinary GPIO'] }));
  return pins;
}

function esp32C3(kind: string): MutablePin[] {
  const pins: MutablePin[] = [];
  const xiao = kind === 'xiao-esp32-c3';
  const labels: Record<number, string> = xiao
    ? { 2: 'D0', 3: 'D1', 4: 'D2', 5: 'D3', 6: 'D4', 7: 'D5', 21: 'D6', 20: 'D7', 8: 'D8', 9: 'D9', 10: 'D10' }
    : {};
  for (let n = 0; n <= 21; n++) {
    const p = gpio(kind, labels[n] ?? String(n), n, {
      exposed: C3_EXPOSED.has(n),
      reserved: n >= 11 && n <= 17,
      strap: [2, 8, 9].includes(n),
    });
    addAlias(p, `GPIO${n}`);
    if (labels[n]) addAlias(p, String(n), `GPIO${n}`);
    if (n === 21) addAlias(p, 'TX', 'TX0', 'TXD');
    if (n === 20) addAlias(p, 'RX', 'RX0', 'RXD');
    if (n === 21) addProtocol(p, 'uart0-tx');
    if (n === 20) addProtocol(p, 'uart0-rx');
    if (n === 8) addProtocol(p, 'i2c0-sda (Arduino default)');
    if (n === 9) addProtocol(p, 'i2c0-scl (Arduino default)');
    if (n === 5) addProtocol(p, 'i2c0-sda-alt');
    if (n === 6) addProtocol(p, 'i2c0-scl-alt');
    if (n >= 0 && n <= 4) addProtocol(p, 'adc1');
    if (!p.inputOnly && !p.reserved) addProtocol(p, 'pwm-ledc');
    if (n >= 11 && n <= 17) addNote(p, 'reserved for SPI flash on common C3 modules');
    if ([18, 19].includes(n)) {
      addNote(p, 'native USB/JTAG; avoid while USB/JTAG is in use');
      p.reserved = true;
    }
    if (p.strap) addNote(p, 'boot strapping pin; verify pull resistors before wiring');
    pins.push(p);
  }
  pins.push(rail(kind, 'GND', 'gnd', null, { aliases: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND.5'] }));
  pins.push(rail(kind, '3V3', '3v3', 3.3, { aliases: ['3V3.1', '3V3.2'] }));
  pins.push(rail(kind, '5V', '5v', 5, { aliases: ['VIN', 'VBUS'] }));
  pins.push(rail(kind, 'RST', 'reset', 3.3, { reserved: true, aliases: ['EN'], notes: ['reset/enable; do not drive as ordinary GPIO'] }));
  return pins;
}

function arduino(kind: string): MutablePin[] {
  const pins: MutablePin[] = [];
  const mega = kind === 'arduino-mega';
  const maxDigital = mega ? 53 : 13;
  for (let n = 0; n <= maxDigital; n++) {
    const p = gpio(kind, String(n), n, { voltage: 5 });
    addAlias(p, `D${n}`);
    if (n === 0) addAlias(p, 'RX', 'RX0');
    if (n === 1) addAlias(p, 'TX', 'TX0');
    if (!mega && n === 10) addProtocol(p, 'spi0-cs');
    if (!mega && n === 11) addProtocol(p, 'spi0-mosi');
    if (!mega && n === 12) addProtocol(p, 'spi0-miso');
    if (!mega && n === 13) {
      addProtocol(p, 'spi0-sck', 'pwm');
      addNote(p, 'on-board LED on common Uno/Nano boards');
    }
    if (mega) {
      const uartByPin: Record<number, string> = { 1: 'uart0-tx', 0: 'uart0-rx', 18: 'uart1-tx', 19: 'uart1-rx', 16: 'uart2-tx', 17: 'uart2-rx', 14: 'uart3-tx', 15: 'uart3-rx' };
      if (uartByPin[n]) addProtocol(p, uartByPin[n]);
      const uartAliases: Record<number, string[]> = {
        1: ['TX0', 'TX'], 0: ['RX0', 'RX'],
        18: ['TX1'], 19: ['RX1'], 16: ['TX2'], 17: ['RX2'], 14: ['TX3'], 15: ['RX3'],
      };
      if (uartAliases[n]) addAlias(p, ...uartAliases[n]);
      if (n === 50) addProtocol(p, 'spi0-miso');
      if (n === 51) addProtocol(p, 'spi0-mosi');
      if (n === 52) addProtocol(p, 'spi0-sck');
      if (n === 53) addProtocol(p, 'spi0-cs');
      if (n === 20) addAlias(p, 'SDA');
      if (n === 21) addAlias(p, 'SCL');
      if (n === 20) addProtocol(p, 'i2c0-sda');
      if (n === 21) addProtocol(p, 'i2c0-scl');
    } else if (n === 0 || n === 1) addProtocol(p, n === 0 ? 'uart0-rx' : 'uart0-tx');
    const pwm = mega ? (n >= 2 && n <= 13) || n === 44 || n === 45 || n === 46 : [3, 5, 6, 9, 10, 11].includes(n);
    if (pwm) addProtocol(p, 'pwm');
    pins.push(p);
  }
  const maxAnalog = mega ? 15 : kind === 'arduino-nano' ? 7 : 5;
  for (let a = 0; a <= maxAnalog; a++) {
    const number = (mega ? 54 : 14) + a;
    const p = gpio(kind, `A${a}`, number, {
      voltage: 5,
      inputOnly: kind === 'arduino-nano' && a >= 6,
      protocols: ['analog'],
    });
    addAlias(p, String(number));
    if (!mega && a === 4) addProtocol(p, 'i2c0-sda');
    if (!mega && a === 5) addProtocol(p, 'i2c0-scl');
    if (p.inputOnly) addNote(p, 'analog input only on Nano');
    pins.push(p);
  }
  pins.push(rail(kind, 'GND', 'gnd', null, { aliases: ['GND.1', 'GND.2', 'GND.3'] }));
  pins.push(rail(kind, '5V', '5v', 5, { aliases: ['VCC'] }));
  pins.push(rail(kind, '3.3V', '3v3', 3.3, { aliases: ['3V3'] }));
  pins.push(rail(kind, 'VIN', 'vin', null, { inputOnly: true, notes: ['raw supply input; use regulated voltage within board limits'] }));
  pins.push(rail(kind, 'RESET', 'reset', 5, { reserved: true, aliases: ['RST'], notes: ['active-low reset; do not drive as GPIO'] }));
  pins.push(rail(kind, 'AREF', 'reference', 5, { reserved: true, aliases: ['IOREF'], notes: ['analog reference; never use as a digital output'] }));
  return pins;
}

function pico(kind: string): MutablePin[] {
  const pins: MutablePin[] = [];
  for (let n = 0; n <= 29; n++) {
    const exposed = n <= 22 || n === 25 || (n >= 26 && n <= 28);
    const p = gpio(kind, `GP${n}`, n, {
      exposed,
      reserved: n === 23 || n === 24 || n === 25 || n === 29,
      inputOnly: false,
    });
    addAlias(p, String(n));
    if (n === 0) addProtocol(p, 'uart0-tx');
    if (n === 1) addProtocol(p, 'uart0-rx');
    if (n === 4) addProtocol(p, 'i2c0-sda');
    if (n === 5) addProtocol(p, 'i2c0-scl');
    if (n === 6) addProtocol(p, 'i2c1-sda');
    if (n === 7) addProtocol(p, 'i2c1-scl');
    if (n === 16) addProtocol(p, 'spi0-miso');
    if (n === 17) addProtocol(p, 'spi0-cs');
    if (n === 18) addProtocol(p, 'spi0-sck');
    if (n === 19) addProtocol(p, 'spi0-mosi');
    if (n >= 26 && n <= 28) addProtocol(p, 'adc');
    addProtocol(p, 'pwm');
    if (n === 25) addNote(p, 'on-board LED; not a header pad on Pico/Pico W');
    if (p.reserved) addNote(p, 'not exposed on the standard Pico header');
    pins.push(p);
  }
  pins.push(rail(kind, 'GND', 'gnd', null, { aliases: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND.5', 'GND.6', 'GND.7', 'GND.8'] }));
  pins.push(rail(kind, '3V3', '3v3', 3.3, { aliases: ['3V3_OUT', '3V3.1'] }));
  pins.push(rail(kind, 'VBUS', '5v', 5, { inputOnly: true, notes: ['USB 5V; do not connect to a 3.3V GPIO'] }));
  pins.push(rail(kind, 'VSYS', 'vin', null, { inputOnly: true, notes: ['1.8–5.5V system supply input'] }));
  pins.push(rail(kind, '3V3_EN', 'reset', 3.3, { reserved: true, notes: ['pull low to disable regulator; do not use as GPIO'] }));
  pins.push(rail(kind, 'RUN', 'reset', 3.3, { reserved: true, notes: ['reset/run control; do not use as GPIO'] }));
  pins.push(rail(kind, 'ADC_VREF', 'reference', 3.3, { reserved: true, notes: ['ADC reference input'] }));
  if (kind === 'raspberry-pi-pico' || kind === 'pi-pico-w') {
    // The rendered elements expose A0/A1/A2 aliases for these three pads.
    const map: Record<string, number> = { A0: 26, A1: 27, A2: 28 };
    for (const [alias, n] of Object.entries(map)) {
      const p = pins.find((entry) => entry.gpio === n);
      if (p) p.aliases.push(alias);
    }
  }
  return pins;
}

function boardFamily(kind: string): 'arduino' | 'pico' | 'esp32' | 'esp32-s3' | 'esp32-c3' | null {
  if (kind === 'arduino-uno' || kind === 'arduino-nano' || kind === 'arduino-mega') return 'arduino';
  if (kind === 'raspberry-pi-pico' || kind === 'pi-pico-w') return 'pico';
  // Nano ESP32 carries an ESP32-S3 (not a classic ESP32), despite the
  // historical kind name lacking the "s3" suffix.
  if (kind === 'arduino-nano-esp32') return 'esp32-s3';
  // M5Stack Core is an overlay board carrying a classic ESP32.  Its kind
  // intentionally does not contain "esp32", so capability lookup alone
  // would otherwise leave it without any safety contract.
  if (kind === 'm5stack-core') return 'esp32';
  const caps = getEsp32Capabilities(kind);
  if (caps?.family === 'esp32-s3') return 'esp32-s3';
  if (caps?.family === 'esp32-c3') return 'esp32-c3';
  if (caps?.family === 'esp32') return 'esp32';
  return null;
}

/** Return a fresh contract list. Mutating the returned objects cannot affect future calls. */
export function getBoardPinContract(boardKind: string): BoardPinContract[] {
  const family = boardFamily(boardKind);
  if (!family) return [];
  const mutable = family === 'arduino'
    ? arduino(boardKind)
    : family === 'pico'
      ? pico(boardKind)
      : family === 'esp32-s3'
        ? esp32S3(boardKind)
        : family === 'esp32-c3'
          ? esp32C3(boardKind)
          : classicEsp32(boardKind);
  return mutable.map(clone);
}

function normalizeName(name: string): string {
  return name.trim().toUpperCase().replace(/\.\d+$/, '');
}

/** Resolve aliases (including GND.1/3V3.2) to the conservative board contract. */
export function resolvePinContract(boardKind: string, pinName: string): BoardPinContract | null {
  const wanted = normalizeName(pinName);
  if (!wanted) return null;
  const found = getBoardPinContract(boardKind).find((pin) =>
    [pin.name, ...pin.aliases].some((name) => normalizeName(name) === wanted),
  );
  return found ?? null;
}

/** Alias retained for callers that prefer the noun-first spelling. */
export const getPinContract = resolvePinContract;

/** Validate a pin for a proposed agent operation. Unknown contracts are errors. */
export function validatePinUse(
  boardKind: string,
  pinName: string,
  use: PinUse = 'wire',
  expectedVoltage?: number,
): PinValidation {
  const pin = resolvePinContract(boardKind, pinName);
  if (!pin) {
    return {
      ok: false,
      pin: null,
      errors: [`No pin contract for ${boardKind}:${pinName}; do not guess a GPIO or voltage.`],
      warnings: [],
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!pin.exposed) errors.push(`${pin.name} is not exposed on the ${boardKind} carrier/header.`);
  if (pin.reserved) errors.push(`${pin.name} is reserved for board hardware (flash/PSRAM/USB/reset).`);
  if ((use === 'output' || use === 'analog') && pin.inputOnly) {
    errors.push(`${pin.name} is input-only and cannot be used as an output.`);
  }
  if (expectedVoltage !== undefined && pin.voltage !== null && Math.abs(pin.voltage - expectedVoltage) > 0.01) {
    errors.push(`${pin.name} is a ${pin.voltage}V pin; requested ${expectedVoltage}V logic is unsafe.`);
  }
  if (pin.strap) warnings.push(`${pin.name} is a boot strapping pin; verify external pull resistors.`);
  if (pin.powerRole && pin.powerRole !== 'gnd') {
    warnings.push(`${pin.name} is a power rail, not a GPIO; connect only to compatible supply pins.`);
  }
  return { ok: errors.length === 0, pin, errors, warnings };
}

/** Compact text safe to append to the agent's `get_pins` result. */
export function formatPinContract(pin: BoardPinContract): string {
  const traits = [
    pin.exposed ? 'exposed' : 'not-exposed',
    pin.reserved ? 'reserved' : null,
    pin.strap ? 'strap' : null,
    pin.inputOnly ? 'input-only' : 'input/output',
    pin.voltage === null ? 'voltage=n/a' : `${pin.voltage}V`,
  ].filter(Boolean);
  const protocols = pin.protocols.length ? `; protocols=${pin.protocols.join(',')}` : '';
  const notes = pin.notes.length ? `; note=${pin.notes.join(' / ')}` : '';
  return `contract: ${traits.join(', ')}${protocols}${notes}`;
}
