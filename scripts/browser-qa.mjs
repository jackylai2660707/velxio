#!/usr/bin/env node
/**
 * browser-qa.mjs — in-browser smoke QA for canvas components.
 *
 * Drives the real dev app in headless Chrome and verifies the layers unit
 * tests cannot see: custom-element registration in the APP entry (main.tsx →
 * elements-register.ts), canvas mount + sizing, wire endpoints landing on
 * pinInfo tips, and the full compile → run → serial/display closed loop
 * through the real toolbar handlers.
 *
 * Run it after adding a component or touching element registration:
 *
 *   bash scripts/dev-start.sh          # frontend :5173 + backend :8001
 *   node scripts/browser-qa.mjs        # uses frontend/node_modules/puppeteer-core
 *
 * Env overrides: QA_APP_URL (default http://localhost:5173/editor),
 * QA_CHROME (default /usr/bin/google-chrome), QA_SHOTS=1 to save screenshots.
 *
 * Wire-geometry method: the canvas renders every component inside a wrapper
 * with a uniform inset, so a store wire endpoint = comp.(x,y) + inset +
 * pinInfo offset. We measure the inset on a reference wokwi element
 * (wokwi-dht22) and require every checked endpoint to match it within 1 px —
 * i.e. new elements must wire exactly like upstream wokwi elements do. A
 * broken pinInfo shows up as `atCorner` / `pin not in pinInfo` instead.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'frontend', 'package.json'));
let puppeteer;
try {
  puppeteer = (await import(require.resolve('puppeteer-core'))).default;
} catch {
  console.error('puppeteer-core not found — run `npm install` in frontend/ first.');
  process.exit(2);
}

const APP = process.env.QA_APP_URL ?? 'http://localhost:5173/editor';
const CHROME =
  process.env.QA_CHROME ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) {
  console.error('No Chrome/Chromium found — set QA_CHROME=/path/to/chrome.');
  process.exit(2);
}

/**
 * What to verify. `sensor` (optional) drives dispatchSensorUpdate and waits
 * for the value to show up on serial. `matrix` waits for the pixel bitmap.
 */
const CASES = [
  {
    example: 'uno-dht11-serial',
    componentId: 'uno-dht11a',
    tag: 'velxio-dht11',
    wires: 3,
    serial: { contains: ['Humidity', '60', '25'], timeoutMs: 25000 },
    sensor: { values: { temperature: 33, humidity: 44 }, expect: ['33', '44'], timeoutMs: 15000 },
  },
  {
    example: 'uno-ds18b20-serial',
    componentId: 'uno-ds18',
    tag: 'velxio-ds18b20',
    wires: 3,
    serial: { contains: ['found: 1', '25.0'], timeoutMs: 30000 },
    sensor: { values: { temperature: -12.5 }, expect: ['-12.5'], timeoutMs: 15000 },
  },
  {
    example: 'uno-max7219-heart',
    componentId: 'uno-matrix1',
    tag: 'velxio-max7219',
    wires: 5,
    matrix: {
      frame: [0x00, 0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18],
      blinks: true,
      timeoutMs: 20000,
    },
  },
];

const results = [];
const log = (...a) => console.log('[qa]', ...a);
function report(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(
  async () => (await import('/src/lib/agentBridge.ts')).getToolbarActions() !== null,
  { timeout: 60000, polling: 500 },
);
log('app ready');

async function load(id) {
  return page.evaluate(async (exId) => {
    const { getExampleById } = await import('/src/data/examples.ts');
    const { loadExample } = await import('/src/utils/loadExample.ts');
    const ex = getExampleById(exId);
    if (!ex) return { ok: false, error: 'example not found' };
    await loadExample(ex);
    await new Promise((r) => setTimeout(r, 1200));
    return { ok: true };
  }, id);
}

async function checkGeometry(componentId, expectedTag) {
  return page.evaluate(
    async (compId, tag) => {
      const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
      const s = useSimulatorStore.getState();
      const comp = s.components.find((c) => c.id === compId);
      if (!comp) return { error: `component ${compId} not in store` };
      const host = document.getElementById(compId);
      if (!host) return { error: `element #${compId} not in DOM` };
      const target = host.tagName.toLowerCase() === tag ? host : (host.querySelector(tag) ?? host);
      const rect = target.getBoundingClientRect();
      const pinInfo = target.pinInfo ?? null;
      const wireChecks = [];
      for (const w of s.wires) {
        for (const end of [w.start, w.end]) {
          if (end.componentId !== compId) continue;
          const pin = (pinInfo ?? []).find((p) => p.name === end.pinName);
          if (!pin) {
            wireChecks.push({ pin: end.pinName, error: 'pin not in pinInfo' });
            continue;
          }
          wireChecks.push({
            pin: end.pinName,
            dx: Math.round((end.x - (comp.x + pin.x)) * 10) / 10,
            dy: Math.round((end.y - (comp.y + pin.y)) * 10) / 10,
            atCorner: Math.abs(end.x - comp.x) < 1 && Math.abs(end.y - comp.y) < 1,
          });
        }
      }
      return {
        defined: !!customElements.get(tag),
        width: rect.width,
        height: rect.height,
        pinCount: pinInfo ? pinInfo.length : 0,
        wireChecks,
      };
    },
    componentId,
    expectedTag,
  );
}

async function compileAndRun() {
  return page.evaluate(async () => {
    const { getToolbarActions } = await import('/src/lib/agentBridge.ts');
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    const a = getToolbarActions();
    if (!a) return { error: 'no toolbar actions' };
    try {
      await a.compile();
    } catch (e) {
      return { error: 'compile threw: ' + (e?.message ?? e) };
    }
    const s = useSimulatorStore.getState();
    const board = s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0];
    if (!s.compiledHex && !board?.compiledProgram) return { error: 'no compiledHex after compile' };
    try {
      await a.run();
    } catch (e) {
      return { error: 'run threw: ' + (e?.message ?? e) };
    }
    return { ok: true };
  });
}

const stopSim = () =>
  page.evaluate(async () => {
    (await import('/src/lib/agentBridge.ts')).getToolbarActions()?.stop();
  });

const serialTail = () =>
  page.evaluate(async () => {
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    const s = useSimulatorStore.getState();
    const board = s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0];
    return (board?.serialOutput ?? s.serialOutput ?? '').slice(-800);
  });

async function waitForSerial(substrings, timeoutMs) {
  const t0 = Date.now();
  let out = '';
  while (Date.now() - t0 < timeoutMs) {
    out = await serialTail();
    if (substrings.every((sub) => out.includes(sub))) return { ok: true, out };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, out };
}

// ── Baseline wrapper inset from the reference wokwi element ─────────────────
let baseline = null;
{
  const l = await load('uno-dht22');
  const g = await checkGeometry('uno-dht1', 'wokwi-dht22');
  if (l.ok && !g.error && g.wireChecks.length && !g.wireChecks[0].error) {
    baseline = { dx: g.wireChecks[0].dx, dy: g.wireChecks[0].dy };
    log('baseline wrapper inset (wokwi-dht22):', JSON.stringify(baseline));
  } else {
    log('WARN baseline measurement failed — falling back to |offset| <= 8px');
  }
}
const wiresOk = (checks, expected) =>
  checks.length === expected &&
  checks.every(
    (w) =>
      !w.error &&
      !w.atCorner &&
      (baseline
        ? Math.abs(w.dx - baseline.dx) <= 1 && Math.abs(w.dy - baseline.dy) <= 1
        : Math.abs(w.dx) <= 8 && Math.abs(w.dy) <= 8),
  );

// ── Cases ───────────────────────────────────────────────────────────────────
for (const c of CASES) {
  log(`--- ${c.example} ---`);
  const l = await load(c.example);
  report(`${c.tag}: example loads`, l.ok, l.error ?? '');
  if (!l.ok) continue;

  const g = await checkGeometry(c.componentId, c.tag);
  if (g.error) {
    report(`${c.tag}: geometry`, false, g.error);
  } else {
    report(
      `${c.tag}: element defined + sized`,
      g.defined && g.width > 20 && g.height > 20,
      `${g.width}x${g.height}, ${g.pinCount} pins`,
    );
    report(`${c.tag}: wires on pin tips`, wiresOk(g.wireChecks, c.wires), JSON.stringify(g.wireChecks));
  }

  const cr = await compileAndRun();
  report(`${c.tag}: compile+run`, !!cr.ok, cr.error ?? '');
  if (cr.ok) {
    if (c.serial) {
      const w = await waitForSerial(c.serial.contains, c.serial.timeoutMs);
      report(`${c.tag}: serial output`, w.ok, w.out.split('\n').slice(-4).join(' | '));
    }
    if (c.sensor) {
      await page.evaluate(
        async (compId, values) => {
          const { dispatchSensorUpdate } = await import('/src/simulation/SensorUpdateRegistry.ts');
          dispatchSensorUpdate(compId, values);
        },
        c.componentId,
        c.sensor.values,
      );
      const w = await waitForSerial(c.sensor.expect, c.sensor.timeoutMs);
      report(`${c.tag}: sensor slider reflected`, w.ok, w.out.split('\n').slice(-4).join(' | '));
    }
    if (c.matrix) {
      const t0 = Date.now();
      let seenFrame = false;
      let seenBlank = false;
      while (Date.now() - t0 < c.matrix.timeoutMs && !(seenFrame && (seenBlank || !c.matrix.blinks))) {
        const px = await page.evaluate((compId, tag) => {
          const host = document.getElementById(compId);
          const el = host?.tagName.toLowerCase() === tag ? host : host?.querySelector(tag);
          return el?.pixels ? Array.from(el.pixels) : null;
        }, c.componentId, c.tag);
        if (px) {
          if (c.matrix.frame.every((v, i) => px[i] === v)) seenFrame = true;
          if (px.every((v) => v === 0)) seenBlank = true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      report(`${c.tag}: display frame rendered`, seenFrame, '');
      if (c.matrix.blinks) report(`${c.tag}: display blinks`, seenBlank, '');
    }
    if (process.env.QA_SHOTS) {
      await page.screenshot({ path: `qa-${c.example}.png` });
    }
  }
  await stopSim();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`);
await browser.close();
process.exit(failed ? 1 : 0);
