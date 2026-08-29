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

  it('recognizes breadboard power rails as supply endpoints', () => {
    // A breadboard's long red/blue rails are the preferred distribution
    // points for power.  They must not fall through to the generic digital
    // colour/type when the other endpoint is an unclassified component pin.
    expect(classifyByPinName('tp.1')).toBe('power-vcc');
    expect(classifyByPinName('tp.50')).toBe('power-vcc');
    expect(classifyByPinName('bp.7')).toBe('power-vcc');
    expect(classifyByPinName('tn.1')).toBe('power-gnd');
    expect(classifyByPinName('tn.50')).toBe('power-gnd');
    expect(classifyByPinName('bn.7')).toBe('power-gnd');
    // Only canonical rail names classify; malformed names stay unknown so
    // the caller can report them instead of silently inventing a net.
    expect(classifyByPinName('tp')).toBeNull();
    expect(classifyByPinName('rail.1')).toBeNull();
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

  it('lets a breadboard rail classify a wire without pin metadata', () => {
    expect(classifyWire(null, 'tp.1', null, 'A')).toBe('power-vcc');
    expect(classifyWire(null, 'bn.12', null, 'C')).toBe('power-gnd');
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

  it('uses red/black power classes for breadboard rail jumpers', async () => {
    useSimulatorStore.getState().addComponent({
      id: 'breadboard-rails', metadataId: 'breadboard', x: 300, y: 200, properties: {},
    });

    const vcc = await executeTool('add_wire', {
      start_component: 'arduino-uno', start_pin: '5V',
      end_component: 'breadboard-rails', end_pin: 'tp.1',
    });
    expect(vcc.isError).toBe(false);
    const gnd = await executeTool('add_wire', {
      start_component: 'arduino-uno', start_pin: 'GND.1',
      end_component: 'breadboard-rails', end_pin: 'bn.1',
    });
    expect(gnd.isError).toBe(false);

    const wires = useSimulatorStore.getState().wires;
    expect(wires[0]).toMatchObject({ signalType: 'power-vcc', color: WIRE_COLORS['power-vcc'] });
    expect(wires[1]).toMatchObject({ signalType: 'power-gnd', color: WIRE_COLORS['power-gnd'] });
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

  it('does not create duplicate visible wires on replay', async () => {
    const first = await executeTool('add_wire', {
      start_component: 'led-1', start_pin: 'A', end_component: 'arduino-uno', end_pin: '13',
    });
    expect(first.isError).toBe(false);
    const second = await executeTool('add_wire', {
      start_component: 'arduino-uno', start_pin: '13', end_component: 'led-1', end_pin: 'A',
    });
    expect(second.isError).toBe(false);
    expect(second.result).toContain('already exists');
    expect(useSimulatorStore.getState().wires).toHaveLength(1);
  });

  it('blocks a visible wire from a seated breadboard leg', async () => {
    useSimulatorStore.getState().addComponent({ id: 'breadboard-1', metadataId: 'breadboard', x: 300, y: 200, properties: {} });
    useSimulatorStore.setState({ wires: [{ id: 'seat', start: { componentId: 'led-1', pinName: 'A', x: 0, y: 0 }, end: { componentId: 'breadboard-1', pinName: '1t.a', x: 0, y: 0 }, waypoints: [], color: '#000', bb: true }] } as never);
    const result = await executeTool('add_wire', {
      start_component: 'led-1', start_pin: 'A', end_component: 'arduino-uno', end_pin: '13',
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('seated on a breadboard');
  });

  it('shifts an occupied breadboard endpoint to a free sibling hole', async () => {
    useSimulatorStore.getState().addComponent({ id: 'breadboard-1', metadataId: 'breadboard', x: 300, y: 200, properties: {} });
    useSimulatorStore.setState({
      wires: [{
        id: 'existing-jumper',
        start: { componentId: 'breadboard-1', pinName: '1t.a', x: 0, y: 0 },
        end: { componentId: 'arduino-uno', pinName: '12', x: 0, y: 0 },
        waypoints: [], color: '#22c55e',
      }],
    } as never);

    const result = await executeTool('add_wire', {
      start_component: 'breadboard-1', start_pin: '1t.a',
      end_component: 'arduino-uno', end_pin: '13',
    });
    expect(result.isError).toBe(false);
    const wires = useSimulatorStore.getState().wires;
    expect(wires).toHaveLength(2);
    expect(wires[1].start.pinName).toBe('1t.b');
    expect(wires[1].end.pinName).toBe('13');
  });

  it('rejects a visible jumper between holes in one breadboard group', async () => {
    useSimulatorStore.getState().addComponent({ id: 'breadboard-1', metadataId: 'breadboard', x: 300, y: 200, properties: {} });

    const result = await executeTool('add_wire', {
      start_component: 'breadboard-1', start_pin: '1t.a',
      end_component: 'breadboard-1', end_pin: '1t.b',
    });
    expect(result.isError).toBe(true);
    expect(result.result).toContain('same-group short');
    expect(useSimulatorStore.getState().wires).toHaveLength(0);
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
