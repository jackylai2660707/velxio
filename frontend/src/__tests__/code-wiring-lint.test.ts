import { describe, expect, it } from 'vitest';
import { formatCodeWiringLint, lintCodeWiring, type CodeWiringLintInput } from '../agent/codeWiringLint';

const wire = (a: string, ap: string, b: string, bp: string, bb = false) => ({
  start: { componentId: a, pinName: ap, x: 0, y: 0 },
  end: { componentId: b, pinName: bp, x: 0, y: 0 },
  bb,
});

const base = (content: string, overrides: Partial<CodeWiringLintInput> = {}): CodeWiringLintInput => ({
  board: { id: 'arduino-uno', boardKind: 'arduino-uno' },
  files: [{ name: 'sketch.ino', content }],
  components: [{ id: 'led-1', metadataId: 'led' }],
  wires: [wire('arduino-uno', '13', 'led-1', 'A')],
  ...overrides,
});

describe('code ↔ wiring lint', () => {
  it('resolves constants and accepts a connected digital output', () => {
    const result = lintCodeWiring(
      base(`#define LED_PIN 13\nvoid setup(){ pinMode(LED_PIN, OUTPUT); }\nvoid loop(){ digitalWrite(LED_PIN, HIGH); }`),
    );
    expect(result.references.some((reference) => reference.numeric === 13)).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('flags an unresolved symbol and an unconnected analog input', () => {
    const result = lintCodeWiring(
      base(
        `const int SENSOR_PIN = A0;\nvoid setup(){ pinMode(UNKNOWN_PIN, INPUT); }\nvoid loop(){ analogRead(SENSOR_PIN); }`,
        { wires: [] },
      ),
    );
    expect(result.issues.some((issue) => issue.code === 'UNRESOLVED_PIN')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'PIN_NOT_WIRED' && issue.kind === 'analog-input')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('checks explicit ESP32 I2C pins and detects an SDA/SCL swap', () => {
    const result = lintCodeWiring({
      board: { id: 'esp32', boardKind: 'esp32' },
      files: [{ name: 'sketch.ino', content: 'Wire.begin(21, 22);' }],
      components: [{ id: 'oled', metadataId: 'ssd1306' }],
      wires: [wire('esp32', '21', 'oled', 'SCL'), wire('esp32', '22', 'oled', 'SDA')],
    });
    expect(result.references.map((reference) => reference.kind)).toEqual(['i2c-sda', 'i2c-scl']);
    expect(result.issues.filter((issue) => issue.code === 'PROTOCOL_PIN_MISMATCH')).toHaveLength(2);
    expect(formatCodeWiringLint(result)).toContain('repair errors');
  });

  it('parses Servo.attach, DHT constructor, and SPI CS references', () => {
    const result = lintCodeWiring({
      board: { id: 'esp32', boardKind: 'esp32' },
      files: [
        {
          name: 'sketch.ino',
          content:
            '#define SERVO_PIN 4\n#define DHT_PIN 15\n#define CS_PIN 5\nDHT dht(DHT_PIN, DHT22);\nServo myServo;\nvoid setup(){ myServo.attach(SERVO_PIN); pinMode(CS_PIN, OUTPUT); }',
        },
      ],
      components: [
        { id: 'servo', metadataId: 'servo' },
        { id: 'dht', metadataId: 'dht22' },
        { id: 'display', metadataId: 'ili9341' },
      ],
      wires: [
        wire('esp32', '4', 'servo', 'PWM'),
        wire('esp32', '15', 'dht', 'SDA'),
        wire('esp32', '5', 'display', 'CS'),
      ],
    });
    expect(result.references.map((reference) => reference.kind)).toEqual(
      expect.arrayContaining(['servo', 'dht-data', 'spi-cs']),
    );
    expect(result.issues).toHaveLength(0);
  });

  it('follows invisible seating wires through a breadboard hole', () => {
    const result = lintCodeWiring({
      board: { id: 'arduino-uno', boardKind: 'arduino-uno' },
      files: [{ name: 'sketch.ino', content: 'digitalWrite(13, HIGH);' }],
      components: [
        { id: 'bb', metadataId: 'breadboard' },
        { id: 'led', metadataId: 'led' },
      ],
      wires: [
        wire('arduino-uno', '13', 'bb', '10t.a'),
        wire('led', 'A', 'bb', '10t.b', true),
      ],
    });
    expect(result.issues).toHaveLength(0);
  });

  it('ignores comments and string literals that resemble API calls', () => {
    const result = lintCodeWiring(
      base('// analogRead(A0);\nSerial.println("digitalWrite(4, HIGH)");\nvoid loop(){}'),
    );
    expect(result.references).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });
});

