/**
 * Small, curated hardware knowledge layer for the agent.
 *
 * This is deliberately data (rather than another prompt blob): search_examples
 * can retrieve an exact, reviewed recipe when a student asks about Raspberry
 * Pi Linux or an ESP32 peripheral.  It does not execute host code and it does
 * not claim that a protocol is simulated when Velxio only models the pins.
 */

export interface HardwareKnowledgeEntry {
  id: string;
  title: string;
  description: string;
  boards: string[];
  tags: string[];
  libraries: string[];
  wiring: string[];
  code: string;
  caveats: string[];
}
/** Reviewed starter recipes. Keep snippets short enough to fit in an agent
 * tool result; users can turn them into a full project through the normal
 * add_board/add_component/add_wire/write_file workflow. */
export const HARDWARE_KNOWLEDGE: readonly HardwareKnowledgeEntry[] = [
  {
    id: 'pi-gpiozero-led-button',
    title: 'Raspberry Pi Linux: gpiozero LED + button',
    description:
      'A safe Raspberry Pi 3/4/5 GPIO starter using gpiozero callbacks. The button uses an internal pull-up and the LED is active-high.',
    boards: ['raspberry-pi-zero', 'raspberry-pi-1', 'raspberry-pi-2', 'raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5'],
    tags: ['raspberry-pi', 'linux', 'python', 'gpiozero', 'gpio', 'led', 'button', 'debounce'],
    libraries: ['gpiozero (system package)'],
    wiring: [
      'LED anode (+) -> physical pin 11 / BCM GPIO17 through 220Ω; LED cathode (-) -> GND.',
      'Pushbutton one side -> physical pin 15 / BCM GPIO22; other side -> GND.',
    ],
    code: `from gpiozero import LED, Button
from signal import pause

led = LED(17)
button = Button(22, pull_up=True, bounce_time=0.05)
button.when_pressed = led.on
button.when_released = led.off
pause()`,
    caveats: [
      'Use BCM GPIO numbers in Python, not physical header numbers.',
      'gpiozero uses lgpio/pigpio underneath depending on the image; do not run arbitrary host shell commands from the agent.',
    ],
  },
  {
    id: 'pi-gpiozero-pwm-servo',
    title: 'Raspberry Pi Linux: gpiozero PWM LED / servo',
    description:
      'Use gpiozero abstractions for a dimmable LED or hobby servo without manually toggling timing loops.',
    boards: ['raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5'],
    tags: ['raspberry-pi', 'linux', 'python', 'gpiozero', 'pwm', 'servo', 'motor'],
    libraries: ['gpiozero (system package)'],
    wiring: [
      'PWM LED: anode -> BCM GPIO18 through 220Ω, cathode -> GND.',
      'Servo: signal -> BCM GPIO18; power from a suitable 5V rail and a common GND (never power a motor from a GPIO).',
    ],
    code: `from gpiozero import PWMLED
from time import sleep

led = PWMLED(18)
for level in (0.0, 0.25, 0.5, 0.75, 1.0):
    led.value = level
    sleep(0.5)
led.off()`,
    caveats: [
      'GPIO18 is a hardware PWM-capable pin on the standard 40-pin header, but gpiozero can fall back to software timing.',
      'For a servo, add a separate supply and common ground; check current before connecting a motor.',
    ],
  },
  {
    id: 'pi-i2c-sensor-python',
    title: 'Raspberry Pi Linux: I²C sensor with smbus2',
    description:
      'Minimal I²C register read pattern for BME280/MPU6050-class sensors. It makes the address and bus explicit so wiring and code agree.',
    boards: ['raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5'],
    tags: ['raspberry-pi', 'linux', 'python', 'i2c', 'smbus2', 'bme280', 'mpu6050', 'sensor'],
    libraries: ['smbus2 (Python package)'],
    wiring: [
      'Sensor SDA -> physical pin 3 / BCM GPIO2 (I²C bus 1 SDA).',
      'Sensor SCL -> physical pin 5 / BCM GPIO3 (I²C bus 1 SCL).',
      'Sensor VCC -> 3.3V and GND -> a Pi GND; use a level shifter for 5V-only modules.',
    ],
    code: `from smbus2 import SMBus

ADDRESS = 0x68  # MPU6050 AD0 low; verify with i2cdetect
with SMBus(1) as bus:
    who_am_i = bus.read_byte_data(ADDRESS, 0x75)
    print(f"WHO_AM_I=0x{who_am_i:02x}")`,
    caveats: [
      'Enable I²C in the guest/image before running and verify the address; 0x68 and 0x69 are common MPU6050 variants.',
      'I²C pull-ups must go to 3.3V. Never expose Pi GPIOs to 5V.',
    ],
  },
  {
    id: 'pi-spi-uart-python',
    title: 'Raspberry Pi Linux: SPI and UART device patterns',
    description:
      'Reference for spidev and pyserial on Pi Linux. Keep chip-select, baud rate, and device paths visible in the project state.',
    boards: ['raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5'],
    tags: ['raspberry-pi', 'linux', 'python', 'spi', 'spidev', 'uart', 'serial', 'pyserial'],
    libraries: ['spidev (Python package)', 'pyserial (Python package)'],
    wiring: [
      'SPI0: MOSI physical pin 19 / GPIO10, MISO pin 21 / GPIO9, SCLK pin 23 / GPIO11, CE0 pin 24 / GPIO8.',
      'UART0: TX physical pin 8 / GPIO14 -> peer RX; RX pin 10 / GPIO15 -> peer TX; connect GND.',
    ],
    code: `import spidev
import serial

spi = spidev.SpiDev(); spi.open(0, 0)
spi.max_speed_hz = 1_000_000
print(spi.xfer2([0x9F, 0, 0, 0]))
uart = serial.Serial('/dev/serial0', 115200, timeout=1)
uart.write(b'hello\\n')`,
    caveats: [
      'Enable SPI/UART in the image and avoid the console UART unless it has been disabled.',
      'SPI and UART are 3.3V logic. Use one common ground and a level shifter for incompatible devices.',
    ],
  },
  {
    id: 'esp32-arduino-wifi-http',
    title: 'ESP32 Arduino: Wi‑Fi station + HTTP endpoint',
    description:
      'A simulator-friendly ESP32 IoT pattern: connect as a station, start a WebServer, and keep GPIO output behind a small route handler.',
    boards: ['esp32', 'esp32-devkit-c-v4', 'esp32-cam', 'wemos-lolin32-lite', 'esp32-s3', 'esp32-c3'],
    tags: ['esp32', 'arduino', 'wifi', 'http', 'webserver', 'iot', 'api', 'gpio'],
    libraries: ['WiFi (ESP32 core)', 'WebServer (ESP32 core)'],
    wiring: ['LED anode -> GPIO2 through 220Ω; LED cathode -> GND (choose a safe GPIO for the exact board).'],
    code: `#include <WiFi.h>
#include <WebServer.h>
WebServer server(80);
void setup() {
  pinMode(2, OUTPUT);
  WiFi.begin("Velxio", "velxio");
  server.on("/led", [] { digitalWrite(2, !digitalRead(2)); server.send(200, "text/plain", "ok"); });
  server.begin();
}
void loop() { server.handleClient(); }`,
    caveats: [
      'Classic ESP32 and C3 Wi‑Fi are emulated through the QEMU worker; ESP32-S3 currently has no emulated Wi‑Fi MAC in the OSS worker.',
      'Do not assume GPIO2 is safe on every board: check boot-strapping, input-only, flash, and camera pins before wiring.',
      'The Velxio gateway exposes an HTTP route only when the runtime reports Wi‑Fi/host forwarding as available.',
    ],
  },
  {
    id: 'esp32-arduino-i2c-adc-pwm',
    title: 'ESP32 Arduino: I²C, ADC, and LEDC/PWM defaults',
    description:
      'A compact ESP32 peripheral reference for planning an IoT circuit before writing the full application.',
    boards: ['esp32', 'esp32-devkit-c-v4', 'wemos-lolin32-lite', 'esp32-s3', 'esp32-c3'],
    tags: ['esp32', 'arduino', 'i2c', 'adc', 'pwm', 'ledc', 'sensor', 'pinout'],
    libraries: ['Wire (ESP32 core)'],
    wiring: [
      'Classic ESP32 default I²C: SDA GPIO21, SCL GPIO22; explicitly call Wire.begin(sda, scl) when using another pair.',
      'ADC input must be an ADC-capable pin; classic ESP32 GPIO34–39 are input-only and cannot drive outputs.',
      'Use ledcAttach/ledcWrite (or the core-compatible wrapper) for PWM; do not treat every GPIO as a safe boot pin.',
    ],
    code: `#include <Wire.h>
void setup() {
  Wire.begin(21, 22);
  analogReadResolution(12);
  // On current ESP32 cores: ledcAttach(pin, 5000, 8); ledcWrite(pin, 128);
}
void loop() { int raw = analogRead(34); (void)raw; delay(50); }`,
    caveats: [
      'ADC channel mapping and attenuation differ by ESP32 family; ask get_pins and board capabilities before selecting a pin.',
      'ESP32-C3 has 22 GPIOs and no classic Bluetooth; ESP32-S3 Wi‑Fi is not available in the OSS QEMU runtime.',
    ],
  },
];

const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'using', 'use', 'make', 'build', 'a', 'an', 'to', 'of', 'on']);

function termsFor(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2 && !STOPWORDS.has(word)) terms.add(word);
  }
  const q = query.toLowerCase();
  const aliases: Array<[RegExp, string[]]> = [
    [/树莓派|樹莓派|raspberry\s*pi/, ['raspberry', 'pi']],
    [/按鈕|按钮/, ['button']],
    [/接線|接线|腳位|引腳|引脚|针脚|針腳/, ['wiring', 'pinout']],
    [/感測器|传感器|傳感器/, ['sensor']],
    [/無線|无线|聯網|联网|網頁|网页/, ['wifi', 'http']],
    [/序列埠|串口|串口通信/, ['uart', 'serial']],
  ];
  for (const [re, aliasesForMatch] of aliases) if (re.test(q)) aliasesForMatch.forEach((x) => terms.add(x));
  return [...terms];
}

function scoreEntry(entry: HardwareKnowledgeEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${entry.id} ${entry.title} ${entry.description} ${entry.boards.join(' ')} ${entry.tags.join(' ')} ${entry.libraries.join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += term.length >= 5 ? 2 : 1;
  }
  return score;
}

export function searchHardwareKnowledge(query: string, limit = 3): HardwareKnowledgeEntry[] {
  const terms = termsFor(query);
  if (terms.length === 0) return [];
  return HARDWARE_KNOWLEDGE
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function hardwareKnowledgeSearchText(query: string, limit = 3): string {
  const matches = searchHardwareKnowledge(query, limit);
  if (matches.length === 0) return '';
  return matches
    .map((entry) => `- ${entry.id} — ${entry.title} [${entry.boards.join(', ')}] ${entry.description}`)
    .join('\n');
}

export function hardwareKnowledgeText(id: string): string | null {
  const entry = HARDWARE_KNOWLEDGE.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const lines = [
    `# ${entry.title}`,
    entry.description,
    `boards: ${entry.boards.join(', ')}`,
    `libraries: ${entry.libraries.join(', ') || 'none (built-in/system)'}`,
    'wiring:',
    ...entry.wiring.map((wire) => `- ${wire}`),
    'code:',
    entry.code,
    'caveats:',
    ...entry.caveats.map((caveat) => `- ${caveat}`),
  ];
  return lines.join('\n');
}
