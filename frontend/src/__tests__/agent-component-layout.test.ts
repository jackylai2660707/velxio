/**
 * Agent placement guard: component footprints must never overlap on canvas.
 *
 * The real editor measures mounted custom elements.  This test supplies the
 * same offsetWidth/offsetHeight values through a tiny document shim, keeping
 * the assertion deterministic in Vitest's node environment.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import registry from '../services/ComponentRegistry';
import { executeTool } from '../agent/tools';
import { useSimulatorStore } from '../store/useSimulatorStore';

type MeasuredElement = {
  offsetWidth: number;
  offsetHeight: number;
  style: Record<string, string>;
};

const originalDocument = (globalThis as { document?: Document }).document;

beforeAll(async () => {
  await registry.loadPromise;
  registry.mergeComponents([
    {
      id: 'resistor',
      tagName: 'wokwi-resistor',
      name: 'Resistor',
      category: 'passive',
      description: 'Resistor',
      thumbnail: '',
      properties: [],
      defaultValues: { value: '220' },
      pinCount: 2,
      tags: ['resistor'],
    },
    {
      id: 'led-red',
      tagName: 'wokwi-led',
      name: 'Red LED',
      category: 'output',
      description: 'Red LED',
      thumbnail: '',
      properties: [],
      defaultValues: { color: 'red' },
      pinCount: 2,
      tags: ['led'],
    },
  ] as Parameters<typeof registry.mergeComponents>[0]);
});

describe('agent add_component — footprint spacing', () => {
  const elements = new Map<string, MeasuredElement>();

  beforeEach(() => {
    elements.clear();
    (globalThis as { document?: Document }).document = {
      getElementById: (id: string) => elements.get(id) ?? null,
    } as unknown as Document;

    const sim = useSimulatorStore.getState();
    for (const board of [...sim.boards]) sim.removeBoard(board.id);
    useSimulatorStore.setState({ components: [], wires: [] } as never);
  });

  afterEach(() => {
    (globalThis as { document?: Document }).document = originalDocument;
  });

  it('nudges a second footprint to a free position instead of stacking it', async () => {
    elements.set('led-a', { offsetWidth: 64, offsetHeight: 40, style: {} });
    elements.set('resistor-a', { offsetWidth: 56, offsetHeight: 20, style: {} });

    const led = await executeTool('add_component', {
      type: 'led-red', id: 'led-a', x: 400, y: 300,
    });
    expect(led.isError).toBe(false);

    const resistor = await executeTool('add_component', {
      type: 'resistor', id: 'resistor-a', x: 400, y: 300,
    });
    expect(resistor.isError).toBe(false);

    const parts = useSimulatorStore.getState().components;
    const a = parts.find((part) => part.id === 'led-a')!;
    const b = parts.find((part) => part.id === 'resistor-a')!;
    const overlaps =
      a.x < b.x + 56 && b.x < a.x + 64 && a.y < b.y + 20 && b.y < a.y + 40;
    expect(overlaps).toBe(false);
    // A free neighbouring column is preferred for a series pair; a vertical
    // fallback remains valid if the row is fully occupied.
    expect(b.x !== a.x || b.y >= a.y + 40).toBe(true);
    expect(resistor.result).toMatch(/moved|overlap|separat/i);
  });
});
