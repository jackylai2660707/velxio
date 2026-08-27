/**
 * Static ESP32 capability knowledge for the agent.
 *
 * The simulator deliberately keeps board pin rendering in web-components and
 * runtime state in the Zustand store.  This small, side-effect-free module is
 * the bridge between those worlds: it gives the agent a conservative hardware
 * contract before it writes code or wires a circuit.  Values describe the
 * silicon family (not every possible carrier-board silk label); board-specific
 * metadata supplied by the pro registry is merged when available.
 */

import { getProBoard } from '../lib/proBoardRegistry';

export type Esp32Family = 'esp32' | 'esp32-s3' | 'esp32-c3' | 'esp32-c6' | 'esp32-p4' | 'esp32-c5' | 'unknown';

export interface Esp32Capabilities {
  family: Esp32Family;
  architecture: 'Xtensa LX6' | 'Xtensa LX7' | 'RISC-V RV32IMC' | 'RISC-V' | 'unknown';
  /** GPIO numbers usable by ordinary Arduino/ESP-IDF sketches. */
  gpio: number[];
  /** ADC channels as GPIO:channel (ADC2 on classic ESP32 is WiFi-conflicted). */
  adc: Array<{ gpio: number; channel: number; unit: 1 | 2 }>;
  adcNotes: string[];
  uart: string[];
  i2c: string;
  spi: string;
  pwm: string;
  wifi: { supported: boolean; mode: 'qemu' | 'browser' | 'unavailable'; notes: string[] };
  ble: { supported: boolean; gatt: boolean; classicBluetooth: boolean; notes: string[] };
  camera: boolean;
  microphone: boolean;
  sd: boolean;
  notes: string[];
}

const CLASSIC_ADC: Esp32Capabilities['adc'] = [
  // ADC1 remains usable while WiFi is active.
  ...[36, 37, 38, 39, 32, 33, 34, 35].map((gpio, channel) => ({ gpio, channel, unit: 1 as const })),
  ...[4, 0, 2, 15, 13, 12, 14, 27, 25, 26].map((gpio, channel) => ({ gpio, channel, unit: 2 as const })),
];

const C3_ADC: Esp32Capabilities['adc'] = [0, 1, 2, 3, 4].map((gpio, channel) => ({ gpio, channel, unit: 1 as const }));
const S3_ADC: Esp32Capabilities['adc'] = Array.from({ length: 10 }, (_, channel) => ({
  gpio: channel + 1,
  channel,
  unit: 1 as const,
}));

function familyFor(kind: string): Esp32Family {
  const registered = getProBoard(kind)?.esp32Family;
  if (registered) return registered;
  if (kind.includes('s3')) return 'esp32-s3';
  if (kind.includes('c3')) return 'esp32-c3';
  if (kind.includes('c6')) return 'esp32-c6';
  if (kind.includes('p4')) return 'esp32-p4';
  if (kind.includes('c5')) return 'esp32-c5';
  if (kind.startsWith('esp32') || kind.includes('lolin32') || kind.includes('nano-esp32')) return 'esp32';
  return 'unknown';
}

/** Return a fresh, JSON-safe capability object for an ESP32-family kind. */
export function getEsp32Capabilities(kind: string): Esp32Capabilities | null {
  const family = familyFor(kind);
  if (family === 'unknown') return null;

  const pro = getProBoard(kind);
  const camera = kind === 'esp32-cam' || Boolean(pro?.builtInCamera);
  const microphone = Boolean(pro?.builtInMicrophone);
  const sd = kind === 'esp32-cam' || Boolean(pro?.builtInSdCsPin !== undefined);

  if (family === 'esp32') {
    return {
      family,
      architecture: 'Xtensa LX6',
      gpio: Array.from({ length: 40 }, (_, i) => i).filter((n) => n < 6 || n > 11),
      adc: CLASSIC_ADC.map((x) => ({ ...x })),
      adcNotes: ['ADC1 (GPIO32-39) works with WiFi; ADC2 (GPIO0,2,4,12-15,25-27) is unavailable while WiFi is active.'],
      uart: ['UART0 (default Serial TX=GPIO1/RX=GPIO3)', 'UART1', 'UART2'],
      i2c: '2 controllers; pins are GPIO-matrix routable (Arduino Wire defaults SDA=21, SCL=22)',
      spi: 'VSPI/HSPI; GPIO-matrix routable (Arduino SPI defaults SCK=18, MISO=19, MOSI=23, CS=5)',
      pwm: 'LEDC hardware PWM (16 channels)',
      wifi: { supported: true, mode: 'qemu', notes: ['Open emulated APs: Velxio-GUEST, PICSimLabWifi, Espressif, MasseyWifi.'] },
      ble: { supported: true, gatt: false, classicBluetooth: true, notes: ['BLE status/advertising is observable; scan, GATT I/O and ESP-NOW are not emulated.'] },
      camera,
      microphone,
      sd,
      notes: ['GPIO34-39 are input-only. GPIO6-11 are connected to SPI flash and should not be wired as digital I/O.'],
    };
  }

  if (family === 'esp32-s3') {
    return {
      family,
      architecture: 'Xtensa LX7',
      gpio: Array.from({ length: 49 }, (_, i) => i),
      adc: S3_ADC,
      adcNotes: ['ADC1 channels 0-9 map to GPIO1-10 in the simulator.'],
      uart: ['UART0 (default Serial TX=GPIO43/RX=GPIO44)', 'UART1', 'UART2'],
      i2c: '2 controllers; GPIO-matrix routable (Arduino Wire defaults SDA=8, SCL=9)',
      spi: 'SPI2/SPI3; GPIO-matrix routable',
      pwm: 'LEDC hardware PWM (8 channels)',
      wifi: { supported: false, mode: 'unavailable', notes: ['Current ESP32-S3 QEMU machine has no WiFi MAC; use classic ESP32 or ESP32-C3 for WiFi projects.'] },
      ble: { supported: true, gatt: false, classicBluetooth: false, notes: ['BLE status/advertising only; no HCI/GATT transport in QEMU.'] },
      camera,
      microphone,
      sd,
      notes: ['GPIO46 is input-only; GPIO0/45/46 are strapping-sensitive on real hardware. Avoid flash/PSRAM pins on carrier boards.'],
    };
  }

  if (family === 'esp32-c3') {
    return {
      family,
      architecture: 'RISC-V RV32IMC',
      gpio: Array.from({ length: 22 }, (_, i) => i),
      adc: C3_ADC,
      adcNotes: ['ADC1 channels 0-4 map to GPIO0-4; ADC2 is not modelled.'],
      uart: ['UART0 (default Serial TX=GPIO21/RX=GPIO20)', 'UART1'],
      i2c: '1 controller; GPIO-matrix routable (Arduino Wire defaults SDA=8, SCL=9)',
      spi: 'SPI2; GPIO-matrix routable',
      pwm: 'LEDC hardware PWM (6 channels)',
      wifi: { supported: true, mode: 'qemu', notes: ['Single-core target; use ADC1 for sensors when WiFi is enabled.'] },
      ble: { supported: true, gatt: false, classicBluetooth: false, notes: ['BLE status/advertising only; Classic Bluetooth is not present.'] },
      camera,
      microphone,
      sd,
      notes: ['22 GPIOs, single core. GPIO8/9 are strapping pins on common DevKit boards.'],
    };
  }

  // C6/P4/C5 are recognised by the private board registry but have no OSS
  // production QEMU machine. Keep their contract explicit so the agent does
  // not promise a runtime that is not installed.
  const architecture = family === 'esp32-p4' || family === 'esp32-c5' ? 'RISC-V' : 'RISC-V RV32IMC';
  return {
    family,
    architecture,
    gpio: [],
    adc: [],
    adcNotes: [],
    uart: [],
    i2c: 'Unavailable in OSS runtime',
    spi: 'Unavailable in OSS runtime',
    pwm: 'Unavailable in OSS runtime',
    wifi: { supported: family === 'esp32-c6' || family === 'esp32-c5', mode: 'unavailable', notes: ['No bundled OSS QEMU machine; hosted/private runtime required.'] },
    ble: { supported: family !== 'esp32-p4', gatt: false, classicBluetooth: false, notes: ['No bundled OSS runtime.'] },
    camera,
    microphone,
    sd,
    notes: ['This chip family is registered for overlays but is not runnable in the open-source production runtime.'],
  };
}
