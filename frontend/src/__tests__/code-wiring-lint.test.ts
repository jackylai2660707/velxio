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

  it('honours an explicit LED_BUILTIN override instead of hiding it as internal', () => {
    const result = lintCodeWiring(
      base('#define LED_BUILTIN 4\nvoid setup(){ pinMode(LED_BUILTIN, OUTPUT); }', {
        wires: [wire('arduino-uno', '4', 'led-1', 'A')],
      }),
    );
    expect(result.references.find((reference) => reference.expression === 'LED_BUILTIN')?.builtin).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it('uses the RP2040 Wire1 default pins rather than reusing Wire0', () => {
    const result = lintCodeWiring({
      board: { id: 'raspberry-pi-pico', boardKind: 'raspberry-pi-pico' },
      files: [{ name: 'sketch.ino', content: 'Wire1.begin();' }],
      components: [{ id: 'oled', metadataId: 'ssd1306' }],
      wires: [wire('raspberry-pi-pico', 'GP6', 'oled', 'SDA'), wire('raspberry-pi-pico', 'GP7', 'oled', 'SCL')],
    });
    expect(result.references.map((reference) => reference.numeric)).toEqual([6, 7]);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
  });

  it('parses MicroPython I2C while ignoring hash comments', () => {
    const result = lintCodeWiring({
      board: { id: 'esp32', boardKind: 'esp32' },
      files: [{ name: 'main.py', content: '# I2C(0, sda=Pin(4), scl=Pin(5))\nfrom machine import I2C, Pin\ni2c = I2C(0, sda=Pin(21), scl=Pin(22))' }],
      components: [{ id: 'oled', metadataId: 'ssd1306' }],
      wires: [wire('esp32', '21', 'oled', 'SDA'), wire('esp32', '22', 'oled', 'SCL')],
    });
    expect(result.references.map((reference) => reference.numeric)).toEqual([21, 22]);
    expect(result.issues).toHaveLength(0);
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

  it('accepts a correctly mapped SPI bus without treating SCK as I2C SCL', () => {
    const result = lintCodeWiring({
      board: { id: 'esp32', boardKind: 'esp32' },
      files: [{ name: 'sketch.ino', content: 'SPI.begin(18, 19, 23, 5);' }],
      components: [{ id: 'tft', metadataId: 'ili9341' }],
      wires: [
        wire('esp32', '18', 'tft', 'SCK'),
        wire('esp32', '19', 'tft', 'MISO'),
        wire('esp32', '23', 'tft', 'MOSI'),
        wire('esp32', '5', 'tft', 'CS'),
      ],
    });
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'PROTOCOL_PIN_MISMATCH')).toBe(false);
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
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
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

  it('resolves pin constants declared in a board header file', () => {
    const result = lintCodeWiring({
      board: { id: 'arduino-uno', boardKind: 'arduino-uno' },
      files: [
        { name: 'pins.h', content: '#define SENSOR_PIN A0\n' },
        { name: 'sketch.ino', content: 'void loop(){ analogRead(SENSOR_PIN); }' },
      ],
      components: [{ id: 'pot', metadataId: 'potentiometer' }],
      wires: [wire('arduino-uno', 'A0', 'pot', 'SIG')],
    });
    expect(result.issues).toHaveLength(0);
  });

  it('flags one GPIO reused as input and push-pull output', () => {
    const result = lintCodeWiring(
      base('void setup(){ pinMode(4, INPUT); } void loop(){ digitalWrite(4, HIGH); }', {
        wires: [wire('arduino-uno', '4', 'led-1', 'A')],
      }),
    );
    expect(result.issues.some((issue) => issue.code === 'CODE_PIN_ROLE_CONFLICT')).toBe(true);
  });

  it('applies board pin contracts to reject ESP32 input-only outputs', () => {
    const result = lintCodeWiring({
      board: { id: 'esp32', boardKind: 'esp32' },
      files: [{ name: 'sketch.ino', content: 'pinMode(34, OUTPUT); digitalWrite(34, HIGH);' }],
      components: [{ id: 'led', metadataId: 'led' }],
      wires: [wire('esp32', '34', 'led', 'A')],
    });
    expect(result.issues.some((issue) => issue.code === 'BOARD_PIN_UNSAFE')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('downgrades indexed pin arrays to a review warning instead of guessing', () => {
    const result = lintCodeWiring(
      base('const int ledPins[] = {2, 3}; void loop(){ digitalWrite(ledPins[i], HIGH); }', {
        wires: [wire('arduino-uno', '2', 'led-1', 'A'), wire('arduino-uno', '3', 'led-1', 'C')],
      }),
    );
    expect(result.issues.some((issue) => issue.code === 'DYNAMIC_PIN_EXPRESSION')).toBe(true);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(false);
  });
});
