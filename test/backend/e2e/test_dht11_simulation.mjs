/**
 * test_dht11_simulation.mjs
 *
 * Full end-to-end test for the ESP32 + DHT11 sensor simulation. The DHT11
 * shares the DHT22SyncHandler waveform in esp32_worker.py — only the payload
 * packing differs (integer bytes [hum, 0, temp, 0, checksum]), so this test
 * asserts the readings come back as whole numbers and that sensor_update
 * changes them.
 *
 * Mirrors exactly what the frontend does:
 *   1. POST /api/compile/  → get firmware_b64
 *   2. WebSocket /api/simulation/ws/{id}
 *   3. send start_esp32 with firmware + sensors:[{sensor_type:'dht11',…}]
 *   4. Watch serial output for temperature/humidity readings
 *   5. Send esp32_sensor_update with new values and verify the output changes
 *
 * Run from anywhere:
 *   node test/backend/e2e/test_dht11_simulation.mjs [--timeout=45] [--backend=http://localhost:8001]
 *
 * Prerequisites: backend on :8001 with libqemu-xtensa.so available.
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND   = process.env.BACKEND_URL
  ?? process.argv.find(a => a.startsWith('--backend='))?.slice(10)
  ?? 'http://localhost:8001';
const WS_BASE   = BACKEND.replace(/^https?:/, m => m === 'https:' ? 'wss:' : 'ws:');
const SESSION   = `test-dht11-${Date.now()}`;
const TIMEOUT_S = parseInt(
  process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? '45'
);
// --board=esp32 (default, xtensa) or --board=esp32-c3 (riscv32)
const BOARD = process.argv.find(a => a.startsWith('--board='))?.slice(8) ?? 'esp32';
const FQBN  = BOARD === 'esp32-c3' ? 'esp32:esp32:esp32c3' : 'esp32:esp32:esp32';

// ─── ESP32 DHT11 sketch (same as the esp32-dht11 example in examples.ts) ─────
const SKETCH = `// ESP32 — DHT11 Temperature & Humidity Sensor
#include <DHT.h>

#define DHT_PIN  4
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(2000);
  Serial.println("ESP32 DHT11 ready!");
}

void loop() {
  delay(2000);

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("DHT11: waiting for sensor...");
    return;
  }
  Serial.printf("Temp: %.1f C   Humidity: %.1f %%\\n", t, h);
}`;

// ─── Sensor config: GPIO4, integer DHT11 values ──────────────────────────────
const DHT11_SENSOR = {
  sensor_type: 'dht11',
  pin: 4,
  temperature: 24.0,
  humidity: 66.0,
};
const UPDATED = { temperature: 33.0, humidity: 44.0 };

// ─── Logging helpers ──────────────────────────────────────────────────────────
const T0  = Date.now();
const ts  = () => `[+${((Date.now() - T0) / 1000).toFixed(3)}s]`;
const C   = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', OK: '\x1b[32m', SERIAL: '\x1b[32m', RESET: '\x1b[0m' };
const log = (lvl, ...a) => console.log(`${C[lvl] ?? ''}${ts()} [${lvl}]${C.RESET}`, ...a);
const info   = (...a) => log('INFO',   ...a);
const ok     = (...a) => log('OK',     ...a);
const err    = (...a) => log('ERROR',  ...a);
const serial = (...a) => log('SERIAL', ...a);

// ─── Step 1: Compile the sketch ───────────────────────────────────────────────
async function compile() {
  info('Compiling DHT11 sketch via POST /api/compile/ ...');
  const res = await fetch(`${BACKEND}/api/compile/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files:      [{ name: 'sketch.ino', content: SKETCH }],
      board_fqbn: FQBN,
    }),
  });
  if (!res.ok) {
    throw new Error(`Compilation HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Compilation error:\n${(body.error ?? body.stderr ?? 'unknown').slice(0, 500)}`);
  }
  const firmware_b64 = body.binary_content ?? body.firmware_b64;
  if (!firmware_b64) {
    throw new Error(`No firmware in response. Keys: ${Object.keys(body).join(', ')}`);
  }
  ok(`Compiled — ${Math.round(firmware_b64.length * 0.75 / 1024)} KB firmware`);
  return firmware_b64;
}

// ─── Step 2: Run simulation via WebSocket ─────────────────────────────────────
function runSimulation(firmware_b64) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${WS_BASE}/api/simulation/ws/${SESSION}`;
    info(`Connecting WebSocket → ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    const serialLines = [];
    const secondBatch = [];
    let updateSent = false;
    let _lineBuf   = '';

    const timer = setTimeout(() => {
      info(`Timeout (${TIMEOUT_S}s) — stopping`);
      ws.close();
      resolve({ timedOut: true, serialLines, secondBatch });
    }, TIMEOUT_S * 1000);

    ws.addEventListener('open', () => {
      ok('WebSocket connected');
      ws.send(JSON.stringify({
        type: 'start_esp32',
        data: {
          board:        BOARD,
          firmware_b64,
          sensors:      [DHT11_SENSOR],
          wifi_enabled: false,
        },
      }));
      info('Sent start_esp32 with DHT11 sensor on GPIO4');
    });

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { type, data } = msg;

      if (type === 'serial_output') {
        _lineBuf += data?.data ?? '';
        let nl;
        while ((nl = _lineBuf.indexOf('\n')) !== -1) {
          const line = _lineBuf.slice(0, nl).replace(/\r$/, '');
          _lineBuf = _lineBuf.slice(nl + 1);
          if (!line.trim()) continue;
          serialLines.push(line);
          serial(`UART: ${line}`);

          if (line.includes('Temp:') && line.includes('Humidity:')) {
            if (!updateSent) {
              info(`First reading — sending esp32_sensor_update (${UPDATED.temperature}°C / ${UPDATED.humidity}%)`);
              ws.send(JSON.stringify({
                type: 'esp32_sensor_update',
                data: { pin: 4, ...UPDATED },
              }));
              updateSent = true;
            } else {
              secondBatch.push(line);
              if (secondBatch.length >= 2) {
                clearTimeout(timer);
                ws.close();
                resolve({ timedOut: false, serialLines, secondBatch });
              }
            }
          }
        }
        return;
      }

      if (type === 'system')  info(`system: ${JSON.stringify(data)}`);
      if (type === 'error')   err(`simulation error: ${JSON.stringify(data)}`);
    });

    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      info(`WebSocket closed (code=${ev.code})`);
      resolve({ timedOut: false, serialLines, secondBatch });
    });

    ws.addEventListener('error', ev => {
      clearTimeout(timer);
      err('WebSocket error:', ev.message ?? ev.type);
      reject(new Error('WebSocket error'));
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log(` TEST: ${BOARD} + DHT11 Sensor Simulation`);
  console.log(' Session:', SESSION);
  console.log(' Backend:', BACKEND);
  console.log(' Timeout:', TIMEOUT_S, 's');
  console.log(` Sensor : GPIO4, Temp=${DHT11_SENSOR.temperature}°C, Humidity=${DHT11_SENSOR.humidity}%`);
  console.log('═'.repeat(60) + '\n');

  let firmware_b64;
  try {
    firmware_b64 = await compile();
  } catch (e) {
    err('Compilation failed:', e.message);
    process.exit(1);
  }

  const result = await runSimulation(firmware_b64);

  console.log('\n' + '═'.repeat(60));
  console.log(' SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Serial lines received  : ${result.serialLines.length}`);
  console.log(`  Lines after update     : ${result.secondBatch.length}`);
  console.log(`  Timed out              : ${result.timedOut}`);
  console.log('\n  All serial output:');
  for (const l of result.serialLines) console.log(`    ${l}`);
  console.log();

  const readings      = result.serialLines.filter(l => l.includes('Temp:'));
  const hasFirstRead  = readings.length > 0;
  const hasSecondRead = result.secondBatch.length > 0;

  const parse = (line) => ({
    t: parseFloat(line.match(/Temp:\s*([\d.]+)/)?.[1] ?? 'NaN'),
    h: parseFloat(line.match(/Humidity:\s*([\d.]+)/)?.[1] ?? 'NaN'),
  });

  let pass = false;
  if (hasFirstRead && hasSecondRead) {
    const first  = parse(readings[0]);
    const second = parse(result.secondBatch[0]);
    // DHT11 payload is integer-only: 24/66 then 33/44, no tenths.
    const firstOk  = first.t === DHT11_SENSOR.temperature && first.h === DHT11_SENSOR.humidity;
    const secondOk = second.t === UPDATED.temperature && second.h === UPDATED.humidity;
    console.log(`  First reading  : ${first.t}°C / ${first.h}%  (expected ${DHT11_SENSOR.temperature}/${DHT11_SENSOR.humidity}) → ${firstOk ? 'ok' : 'MISMATCH'}`);
    console.log(`  Second reading : ${second.t}°C / ${second.h}%  (expected ${UPDATED.temperature}/${UPDATED.humidity}) → ${secondOk ? 'ok' : 'MISMATCH'}`);
    pass = firstOk && secondOk;
  }

  if (pass) {
    console.log('\x1b[32m  ✓ PASS — DHT11 integer readings correct and sensor_update applies\x1b[0m');
    process.exit(0);
  }
  if (result.timedOut && !hasFirstRead) {
    console.log('\x1b[31m  ✗ FAIL — Timed out with no temperature readings\x1b[0m');
    console.log('\x1b[33m  → Look for "DHT22 sync armed gpio=4" (dht11 shares the handler) in backend logs.\x1b[0m');
  } else {
    console.log('\x1b[31m  ✗ FAIL — readings missing or values wrong (see summary above)\x1b[0m');
  }
  process.exit(1);
}

main().catch(e => { err(e.stack ?? e.message); process.exit(1); });
