/**
 * Part B (verification loop) tests — observation decoders, interact
 * validation, example retrieval, and compile-error hints. Runs in the node
 * environment: DOM-dependent paths degrade exactly as they do before elements
 * mount in the browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  decodeSevenSegment,
  decodeLcd,
  describeOled,
  describeMatrix,
  diffSnapshots,
  observeSimulation,
} from '../agent/observation';
import { interact } from '../agent/interaction';
import { searchExamplesText, getExampleText } from '../agent/exampleSearch';
import { compileErrorHints } from '../agent/errorHints';
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { useSimulatorStore } from '../store/useSimulatorStore';

describe('observation decoders', () => {
  it('decodes 7-segment patterns to digits', () => {
    expect(decodeSevenSegment([1, 1, 1, 1, 1, 1, 0, 0])).toContain('"0"');
    expect(decodeSevenSegment([0, 1, 1, 0, 0, 0, 0, 0])).toContain('"1"');
    expect(decodeSevenSegment([1, 1, 1, 1, 1, 1, 1, 1])).toContain('"8"');
    expect(decodeSevenSegment([1, 1, 1, 1, 1, 1, 1, 1])).toContain('decimal point');
    expect(decodeSevenSegment(null)).toBeNull();
  });

  it('decodes LCD character grids (16x2 and 20x4)', () => {
    const chars = new Uint8Array(32).fill(0x20);
    const text = 'Temp: 24.0 C';
    for (let i = 0; i < text.length; i++) chars[i] = text.charCodeAt(i);
    const out = decodeLcd(chars);
    expect(out).toContain('row 0: "Temp: 24.0 C');
    expect(out).toContain('row 1:');
    const big = new Uint8Array(80).fill(0x41);
    expect(decodeLcd(big)?.split('\n')).toHaveLength(4);
    expect(decodeLcd(new Uint8Array(0))).toBeNull();
  });

  it('describes OLED image data with lit-pixel count', () => {
    const width = 128;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    // light up the top-left 16x16 square
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
    const out = describeOled({ width, height, data });
    expect(out).toContain('256 lit pixels');
    expect(out).toContain('#');
    expect(describeOled({ width, height, data: new Uint8ClampedArray(width * height * 4) })).toBe(
      'display is blank (0 lit pixels)',
    );
  });

  it('describes MAX7219 pixel bitmaps as dot-count + row art', () => {
    const heart = new Uint8Array([0x00, 0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18]);
    const out = describeMatrix(heart);
    expect(out).toContain('40 of 64 dots lit');
    expect(out).toContain('.##..##.'); // row 1 = 0x66, bit 7 leftmost
    expect(out).toContain('...##...'); // row 7 = 0x18
    expect(describeMatrix(new Uint8Array(8))).toBe('matrix is blank (0 of 64 dots lit)');
    expect(describeMatrix(new Uint8Array(4))).toBeNull();
    expect(describeMatrix(undefined)).toBeNull();
  });

  it('diffs output snapshots', () => {
    const before = new Map([['led-1', { value: false as const }]]);
    const after = new Map([['led-1', { value: true as const }]]);
    expect(diffSnapshots(before, after)).toEqual(['led-1.value: OFF → ON']);
    expect(diffSnapshots(after, after)).toEqual([]);
  });
});

describe('observeSimulation (node — no DOM)', () => {
  beforeEach(() => {
    useSimulatorStore.setState({
      boards: [],
      components: [],
      wires: [],
      burntComponents: new Set(),
    } as never);
  });

  it('reports not-running and burnt components', async () => {
    useSimulatorStore.getState().addBoard('arduino-uno', 50, 50);
    useSimulatorStore.setState({ burntComponents: new Set(['led-1']) } as never);
    const report = await observeSimulation({ durationMs: 0 });
    expect(report).toContain('SIMULATION IS NOT RUNNING');
    expect(report).toContain('BURNT COMPONENTS');
    expect(report).toContain('led-1');
  });
});

describe('interact validation (node — no DOM)', () => {
  beforeEach(() => {
    useSimulatorStore.setState({
      boards: [],
      components: [],
      wires: [],
      burntComponents: new Set(),
    } as never);
  });

  it('rejects unknown components with the available list', async () => {
    await expect(interact({ componentId: 'nope', action: 'click' })).rejects.toThrow(
      /not found/,
    );
  });

  it('set_sensor validates keys against SENSOR_CONTROLS', async () => {
    useSimulatorStore
      .getState()
      .addComponent({ id: 'dht-1', metadataId: 'dht22', x: 0, y: 0, properties: {} });
    await expect(
      interact({ componentId: 'dht-1', action: 'set_sensor', values: { temp: 35 } }),
    ).rejects.toThrow(/temperature, humidity/);
    const ok = await interact({
      componentId: 'dht-1',
      action: 'set_sensor',
      values: { temperature: 35 },
      observeMs: 0,
    });
    expect(ok).toContain('"temperature":35');
    expect(ok).toContain('not running');
  });

  it('set_sensor on a non-sensor component lists capable types', async () => {
    useSimulatorStore
      .getState()
      .addComponent({ id: 'led-x', metadataId: 'led-red', x: 0, y: 0, properties: {} });
    await expect(
      interact({ componentId: 'led-x', action: 'set_sensor', values: { lux: 1 } }),
    ).rejects.toThrow(/dht22/);
  });
});

describe('example retrieval', () => {
  it('search_examples finds matches with ids and boards', () => {
    const out = searchExamplesText('oled');
    expect(out).toContain('- ');
    expect(out).toContain('get_example');
  });

  it('search_examples maps Chinese queries', () => {
    const out = searchExamplesText('做一个红绿灯');
    expect(out).toMatch(/traffic|light/i);
  });

  it('get_example returns full wiring and code for a real id', () => {
    const full = getExampleText('uno-oled-4pin-i2c');
    expect(full).toContain('wires (copy this pin-level wiring):');
    expect(full).toContain('code:');
    expect(full).toContain('Adafruit SSD1306');
  });

  it('get_example handles unknown ids gracefully', () => {
    expect(getExampleText('no-such-example')).toContain('search_examples');
  });
});

describe('compile error hints', () => {
  it('maps missing headers to search_libraries', () => {
    const hints = compileErrorHints('fatal error: Adafruit_SSD1306.h: No such file or directory');
    expect(hints[0]).toContain('search_libraries "Adafruit_SSD1306"');
  });

  it('maps undeclared identifiers and duplicate setup', () => {
    expect(compileErrorHints("error: 'Servo' was not declared in this scope")[0]).toContain(
      'Servo',
    );
    expect(compileErrorHints("error: redefinition of 'void setup()'")[0]).toContain('sketch.ino');
  });

  it('returns nothing for unknown errors', () => {
    expect(compileErrorHints('something exotic happened')).toEqual([]);
  });
});

describe('project snapshot burnt flag', () => {
  it('marks burnt components in the snapshot', () => {
    useSimulatorStore.setState({
      boards: [],
      wires: [],
      components: [],
      burntComponents: new Set(),
    } as never);
    useSimulatorStore
      .getState()
      .addComponent({ id: 'led-b', metadataId: 'led-red', x: 0, y: 0, properties: {} });
    useSimulatorStore.setState({ burntComponents: new Set(['led-b']) } as never);
    expect(buildProjectSnapshot()).toContain('[BURNT');
  });
});
