/**
 * new-sensors-real-firmware.test.ts
 *
 * End-to-end acceptance for the DHT11 / DS18B20 / MAX7219 part simulations
 * against REAL Arduino libraries — the exact flow production uses:
 *
 *   inline .ino source → arduino-cli compile → AVRSimulator.loadHex →
 *   attachEvents(part) → step loop → assert serial output / element state
 *
 * The 1-Wire and DHT single-wire timings are easy to get right on paper and
 * wrong against the real libraries (OneWire disables interrupts and busy-
 * waits in µs; the DHT lib decodes by pulse-width ratio), so these tests are
 * the primary proof the protocols actually work.
 *
 * Requirements: arduino-cli + arduino:avr core, plus the per-suite library
 * (OneWire+DallasTemperature / DHT sensor library / LedControl). Anything
 * missing → the suite skips, matching i2c-real-firmware.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ProtocolParts';
import '../simulation/parts/Max7219Part';
import '../simulation/parts/OneWireParts';

const COMPILE_TIMEOUT = 240_000;

// ─── Availability gates ──────────────────────────────────────────────────────

const ARDUINO_CLI_AVAILABLE = (() => {
  const r = spawnSync('arduino-cli', ['version'], { encoding: 'utf-8' });
  return r.error == null && r.status === 0;
})();

function hasLibrary(header: string): boolean {
  if (!ARDUINO_CLI_AVAILABLE) return false;
  const dir = mkdtempSync(join(tmpdir(), 'velxio-libprobe-'));
  const sketchDir = join(dir, 'probe');
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, 'probe.ino'), `#include <${header}>\nvoid setup(){}\nvoid loop(){}\n`);
  const r = spawnSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', sketchDir], {
    encoding: 'utf-8',
    timeout: COMPILE_TIMEOUT,
  });
  return r.status === 0;
}

const DHT_AVAILABLE = hasLibrary('DHT.h');
const DALLAS_AVAILABLE = hasLibrary('DallasTemperature.h');
const LEDCONTROL_AVAILABLE = hasLibrary('LedControl.h');

// ─── Compile helper (inline source, hex cached per content hash) ─────────────

function compileInline(name: string, source: string): string {
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) | 0;
  const hexCache = join(tmpdir(), `velxio-${name}-${hash >>> 0}.hex`);
  if (existsSync(hexCache)) return readFileSync(hexCache, 'utf-8');

  const work = mkdtempSync(join(tmpdir(), `velxio-${name}-`));
  const sketchDir = join(work, name);
  mkdirSync(sketchDir);
  writeFileSync(join(sketchDir, `${name}.ino`), source);
  const buildDir = join(work, 'build');
  mkdirSync(buildDir);

  const result = spawnSync(
    'arduino-cli',
    ['compile', '--fqbn', 'arduino:avr:uno', '--output-dir', buildDir, sketchDir],
    { encoding: 'utf-8', timeout: COMPILE_TIMEOUT },
  );
  if (result.status !== 0) {
    throw new Error(`arduino-cli compile failed:\n${result.stderr}\n${result.stdout}`);
  }
  const hex = readFileSync(join(buildDir, `${name}.ino.hex`), 'utf-8');
  writeFileSync(hexCache, hex);
  return hex;
}

// ─── Runtime helpers ─────────────────────────────────────────────────────────

function runUntil(sim: AVRSimulator, budget: number, predicate: () => boolean): number {
  for (let i = 0; i < budget; i++) {
    sim.step();
    if ((i & 0x3ff) === 0 && predicate()) return i + 1;
  }
  return budget;
}

function makeRig(hex: string) {
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex);
  let serial = '';
  sim.onSerialData = (ch: string) => {
    serial += ch;
  };
  return { sim, getSerial: () => serial };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

// ─── DHT11 (Adafruit DHT sensor library) ─────────────────────────────────────

describe.runIf(DHT_AVAILABLE)('DHT11 E2E — real DHT sensor library', () => {
  let HEX: string;
  beforeAll(() => {
    HEX = compileInline(
      'dht11_e2e',
      `#include <DHT.h>
DHT dht(7, DHT11);
void setup() {
  Serial.begin(115200);
  dht.begin();
}
void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) { Serial.println("READ_FAIL"); }
  else {
    Serial.print("H="); Serial.print(h, 0);
    Serial.print(" T="); Serial.println(t, 0);
  }
  delay(2100);
}`,
    );
  }, COMPILE_TIMEOUT);

  it(
    'firmware reads back the element temperature/humidity',
    () => {
      const { sim, getSerial } = makeRig(HEX);
      const element = { temperature: 24, humidity: 66 } as unknown as HTMLElement;
      const cleanup = PartSimulationRegistry.get('dht11')!.attachEvents!(
        element,
        sim as any,
        pinMap({ SDA: 7 }),
        'dht11-e2e',
      );
      // begin() + 20 ms start signal + response — 50 M cycles ≫ enough.
      runUntil(sim, 50_000_000, () => getSerial().includes('\n'));
      cleanup();
      expect(getSerial()).toContain('H=66 T=24');
      expect(getSerial()).not.toContain('READ_FAIL');
    },
    120_000,
  );
});

// ─── DS18B20 (OneWire + DallasTemperature) ───────────────────────────────────

describe.runIf(DALLAS_AVAILABLE)('DS18B20 E2E — real OneWire + DallasTemperature', () => {
  let HEX: string;
  beforeAll(() => {
    HEX = compileInline(
      'ds18b20_e2e',
      `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire oneWire(2);
DallasTemperature sensors(&oneWire);
void setup() {
  Serial.begin(115200);
  sensors.begin();
  Serial.print("FOUND=");
  Serial.println(sensors.getDeviceCount());
  sensors.setWaitForConversion(false);  // skip the 750 ms blocking wait —
  sensors.requestTemperatures();        // our Convert T completes instantly
  Serial.print("T=");
  Serial.println(sensors.getTempCByIndex(0), 2);
}
void loop() {}`,
    );
  }, COMPILE_TIMEOUT);

  it(
    'search ROM finds the device and getTempCByIndex returns the slider value',
    () => {
      const { sim, getSerial } = makeRig(HEX);
      const element = { temperature: 21.5 } as unknown as HTMLElement;
      const cleanup = PartSimulationRegistry.get('ds18b20')!.attachEvents!(
        element,
        sim as any,
        pinMap({ DQ: 2 }),
        'ds18b20-e2e',
      );
      runUntil(sim, 80_000_000, () => getSerial().includes('T='));
      // Let the T= line finish printing.
      runUntil(sim, 2_000_000, () => getSerial().includes('T=') && getSerial().endsWith('\n'));
      cleanup();
      expect(getSerial()).toContain('FOUND=1');
      expect(getSerial()).toContain('T=21.50');
    },
    120_000,
  );
});

// ─── MAX7219 (LedControl) ────────────────────────────────────────────────────

describe.runIf(LEDCONTROL_AVAILABLE)('MAX7219 E2E — real LedControl library', () => {
  const HEART = [0x00, 0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18];
  let HEX: string;
  beforeAll(() => {
    HEX = compileInline(
      'max7219_e2e',
      `#include <LedControl.h>
LedControl lc = LedControl(12, 11, 10, 1);  // DIN, CLK, CS
const byte HEART[8] = {0x00, 0x66, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C, 0x18};
void setup() {
  lc.shutdown(0, false);
  lc.setIntensity(0, 8);
  lc.clearDisplay(0);
  for (int row = 0; row < 8; row++) lc.setRow(0, row, HEART[row]);
}
void loop() {}`,
    );
  }, COMPILE_TIMEOUT);

  it(
    'shiftOut frames land in element.pixels as the heart bitmap',
    () => {
      const { sim } = makeRig(HEX);
      const element = {} as unknown as HTMLElement & {
        pixels?: Uint8Array;
        shutdown?: boolean;
      };
      const cleanup = PartSimulationRegistry.get('max7219')!.attachEvents!(
        element,
        sim as any,
        pinMap({ DIN: 12, CLK: 11, CS: 10 }),
        'max7219-e2e',
      );
      runUntil(
        sim,
        20_000_000,
        () => element.pixels != null && HEART.every((row, i) => element.pixels![i] === row),
      );
      cleanup();
      expect(element.shutdown).toBe(false);
      expect(Array.from(element.pixels!)).toEqual(HEART);
    },
    120_000,
  );
});

// Keep vitest happy when everything is gated off in this environment.
describe.runIf(!ARDUINO_CLI_AVAILABLE)('real-firmware suite', () => {
  it('skipped — arduino-cli unavailable', () => {
    expect(ARDUINO_CLI_AVAILABLE).toBe(false);
  });
});
