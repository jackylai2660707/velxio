/**
 * Wiring/layout standards — signal classification, auto wire colors, and
 * add_component grid snapping. Node environment: DOM measurement is
 * unavailable, so classification exercises the pin-NAME fallback (exactly
 * what custom velxio elements without `signals` metadata hit in production).
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { classifyByPinName, classifyWire } from '../agent/wireStandards';
import { WIRE_COLORS } from '../utils/wireColors';
import { executeTool } from '../agent/tools';
import registry from '../services/ComponentRegistry';
import { useSimulatorStore } from '../store/useSimulatorStore';

beforeAll(async () => {
  // In node the registry's metadata fetch fails silently — seed what we use.
  await registry.loadPromise;
  registry.mergeComponents([
    {
      id: 'led-red',
      tagName: 'wokwi-led',
      name: 'Red LED',
      category: 'output',
      description: 'A red LED',
      thumbnail: '',
      properties: [],
      defaultValues: { color: 'red' },
      pinCount: 2,
      tags: ['led'],
    },
  ] as Parameters<typeof registry.mergeComponents>[0]);
});

describe('classifyByPinName', () => {
  it('recognizes power, bus, serial, and analog pins', () => {
    expect(classifyByPinName('GND.1')).toBe('power-gnd');
    expect(classifyByPinName('GND')).toBe('power-gnd');
    expect(classifyByPinName('5V')).toBe('power-vcc');
    expect(classifyByPinName('3.3V')).toBe('power-vcc');
    expect(classifyByPinName('VCC')).toBe('power-vcc');
    expect(classifyByPinName('VIN')).toBe('power-vcc');
    expect(classifyByPinName('SDA')).toBe('i2c');
    expect(classifyByPinName('A4', 'SDA')).toBe('i2c'); // description carries the role
    expect(classifyByPinName('MOSI')).toBe('spi');
    expect(classifyByPinName('SCK')).toBe('spi');
    expect(classifyByPinName('TX')).toBe('usart');
    expect(classifyByPinName('RX0')).toBe('usart');
    expect(classifyByPinName('A0')).toBe('analog');
    expect(classifyByPinName('13')).toBeNull();
    expect(classifyByPinName('A')).toBeNull(); // LED anode is not analog
  });
});

describe('classifyWire', () => {
  it('lets the more specific endpoint win', () => {
    // GND pin to a plain digital pin → ground wire
    expect(classifyWire(null, 'GND.1', null, '13')).toBe('power-gnd');
    expect(classifyWire(null, '13', null, 'GND.2')).toBe('power-gnd');
    // I2C beats analog naming
    expect(classifyWire(null, 'SDA', null, 'A4')).toBe('i2c');
    // no clues → digital
    expect(classifyWire(null, '13', null, 'A')).toBe('digital');
  });

  it('uses pinInfo signals when available', () => {
    const pins = [{ name: 'VCC', signals: [{ type: 'power', signal: 'VCC' }] }];
    expect(classifyWire(pins, 'VCC', null, '1')).toBe('power-vcc');
  });
});

describe('add_wire auto colors', () => {
  beforeEach(() => {
    const sim = useSimulatorStore.getState();
    for (const b of [...sim.boards]) sim.removeBoard(b.id);
    useSimulatorStore.setState({ components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard('arduino-uno', 50, 50);
    useSimulatorStore
      .getState()
      .addComponent({ id: 'led-1', metadataId: 'led-red', x: 400, y: 60, properties: {} });
  });

  it('assigns the standard color and signalType when color is omitted', async () => {
    const gnd = await executeTool('add_wire', {
      start_component: 'led-1',
      start_pin: 'C',
      end_component: 'arduino-uno',
      end_pin: 'GND.1',
    });
    expect(gnd.isError).toBe(false);
    expect(gnd.result).toContain('power-gnd');
    const wire1 = useSimulatorStore.getState().wires[0];
    expect(wire1.color).toBe(WIRE_COLORS['power-gnd']);
    expect(wire1.signalType).toBe('power-gnd');

    const sig = await executeTool('add_wire', {
      start_component: 'led-1',
      start_pin: 'A',
      end_component: 'arduino-uno',
      end_pin: '13',
    });
    expect(sig.isError).toBe(false);
    const wire2 = useSimulatorStore.getState().wires[1];
    expect(wire2.color).toBe(WIRE_COLORS['digital']);
    expect(wire2.signalType).toBe('digital');
  });

  it('classifies I2C by pin name', async () => {
    useSimulatorStore
      .getState()
      .addComponent({ id: 'oled-1', metadataId: 'ssd1306', x: 400, y: 200, properties: {} });
    await executeTool('add_wire', {
      start_component: 'oled-1',
      start_pin: 'SDA',
      end_component: 'arduino-uno',
      end_pin: 'A4',
    });
    const wire = useSimulatorStore.getState().wires.at(-1)!;
    expect(wire.signalType).toBe('i2c');
    expect(wire.color).toBe(WIRE_COLORS['i2c']);
  });

  it('respects an explicit color but still records the signalType', async () => {
    await executeTool('add_wire', {
      start_component: 'led-1',
      start_pin: 'C',
      end_component: 'arduino-uno',
      end_pin: 'GND.1',
      color: 'yellow',
    });
    const wire = useSimulatorStore.getState().wires.at(-1)!;
    expect(wire.color).toBe('yellow');
    expect(wire.signalType).toBe('power-gnd');
  });
});

describe('add_component grid snap', () => {
  it('snaps provided coordinates to the 20px grid', async () => {
    const sim = useSimulatorStore.getState();
    for (const b of [...sim.boards]) sim.removeBoard(b.id);
    useSimulatorStore.setState({ components: [], wires: [] } as never);

    const r = await executeTool('add_component', { type: 'led-red', x: 403, y: 418 });
    expect(r.isError).toBe(false);
    expect(r.result).toContain('(400, 420)');
    const c = useSimulatorStore.getState().components[0];
    expect(c.x).toBe(400);
    expect(c.y).toBe(420);
  });
});
