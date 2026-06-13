/**
 * picow-littlefs-utf8.investigate.test.ts  (gated: CYW43_PROD_HARNESS=1)
 *
 * Reproduces the EXACT user path for the async-LED Wi-Fi example: write it to
 * LittleFS as main.py via the REAL loadUserFiles (not mocked), boot, and let
 * main.py auto-run. Before the UTF-8 byte-length fix the 2 em-dashes truncated
 * the file -> SyntaxError. This asserts the example now runs (no SyntaxError,
 * reaches the Wi-Fi connect).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const FW_PATH = '/home/dave/velxio-prod/velxio/frontend/public/firmware/micropython-rp2040w.uf2';
const WASM_PATH = '/home/dave/velxio-prod/velxio/frontend/node_modules/littlefs/dist/littlefs.wasm';

// Only mock getFirmware (IndexedDB/fetch) — keep loadUserFiles REAL.
vi.mock('../simulation/MicroPythonLoader', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFirmware: async () => new Uint8Array(readFileSync(FW_PATH)) };
});
// Inject the WASM bytes directly so Emscripten never fetches (no browser).
vi.mock('littlefs', async (orig) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await orig()) as any;
  const create = actual.default;
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: (cfg: any = {}) => create({ ...cfg, wasmBinary: new Uint8Array(readFileSync(WASM_PATH)) }),
  };
});

function asyncLedMainPy(): string {
  const src = readFileSync(
    '/home/dave/velxio-prod/velxio/frontend/src/data/examples-picow-wifi.ts', 'utf8');
  const m = src.match(/const ASYNC_LED_CONTROL_PY = withVelxioGuest\(`([\s\S]*?)`\);/);
  if (!m) throw new Error('template not found');
  // eslint-disable-next-line no-eval
  return eval('`' + m[1] + '`') as string;
}

describe.skipIf(!process.env.CYW43_PROD_HARNESS)('async-LED example via real LittleFS', () => {
  it('boots main.py with no SyntaxError and connects Wi-Fi', async () => {
    const { RP2040Simulator } = await import('../simulation/RP2040Simulator');
    const { PinManager } = await import('../simulation/PinManager');
    const sim = new RP2040Simulator(new PinManager());
    let serial = '';
    sim.onSerialData = (ch: string) => { serial += ch; if (serial.length > 60000) serial = serial.slice(-30000); };
    sim.attachCyw43();
    await sim.loadMicroPython([{ name: 'main.py', content: asyncLedMainPy() }]);

    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      for (let i = 0; i < 16; i++) sim.runFrameForTime(50);
      if (serial.includes('SyntaxError') || serial.includes('IP:') || serial.includes('Server running')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    try { sim.stop(); } catch { /* noop */ }
    // eslint-disable-next-line no-console
    console.log('\n===== ASYNC-LED LittleFS RUN =====\n' + serial.slice(-700));

    expect(serial).not.toContain('SyntaxError');
    expect(serial).toMatch(/IP:|Connecting WiFi|Server running/);
  }, 110_000);
});
