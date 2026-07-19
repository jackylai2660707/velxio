/**
 * AI assistant tool-layer tests.
 *
 * Runs in the node environment (no DOM): pin verification is soft-skipped
 * exactly as it is before elements mount in the browser, so these tests cover
 * the store mutations, validation errors, and file editing semantics.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { executeTool } from '../agent/tools';
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { trimHistory } from '../agent/AgentRunner';
import registry from '../services/ComponentRegistry';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import type { ApiMessage } from '../agent/types';

beforeAll(async () => {
  // In node the registry's fetch of /components-metadata.json fails silently;
  // seed the two types the tests need.
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
    {
      id: 'resistor',
      tagName: 'wokwi-resistor',
      name: 'Resistor',
      category: 'passive',
      description: 'A resistor',
      thumbnail: '',
      properties: [{ name: 'value', type: 'string', defaultValue: '220' }],
      defaultValues: { value: '220' },
      pinCount: 2,
      tags: ['resistor'],
    },
  ] as Parameters<typeof registry.mergeComponents>[0]);
});

describe('agent tools — boards', () => {
  it('adds a board and makes it active', async () => {
    const before = new Set(useSimulatorStore.getState().boards.map((b) => b.id));
    const res = await executeTool('add_board', { board_kind: 'arduino-uno', x: 40, y: 60 });
    expect(res.isError).toBe(false);
    const sim = useSimulatorStore.getState();
    const added = sim.boards.find((b) => !before.has(b.id));
    expect(added).toBeTruthy();
    expect(added!.boardKind).toBe('arduino-uno');
    expect(sim.activeBoardId).toBe(added!.id);
  });

  it('rejects unknown board kinds', async () => {
    const res = await executeTool('add_board', { board_kind: 'banana-pi' });
    expect(res.isError).toBe(true);
    expect(res.result).toContain('Unknown board kind');
  });
});

describe('agent tools — components & wires', () => {
  it('rejects unknown component types with suggestions', async () => {
    const res = await executeTool('add_component', { type: 'red-led', x: 0, y: 0 });
    expect(res.isError).toBe(true);
    expect(res.result).toContain('Unknown component type');
  });

  it('adds a component with auto id and default properties', async () => {
    const res = await executeTool('add_component', { type: 'led-red', x: 400, y: 100 });
    expect(res.isError).toBe(false);
    const comp = useSimulatorStore.getState().components.find((c) => c.metadataId === 'led-red');
    expect(comp).toBeTruthy();
    expect(comp!.id).toBe('led-red-1');
    expect(comp!.properties.color).toBe('red');
  });

  it('merges properties on update_component', async () => {
    await executeTool('add_component', { type: 'resistor', x: 500, y: 100 });
    const res = await executeTool('update_component', {
      id: 'resistor-1',
      properties: { value: '330' },
    });
    expect(res.isError).toBe(false);
    const comp = useSimulatorStore.getState().components.find((c) => c.id === 'resistor-1');
    expect(comp!.properties.value).toBe('330');
  });

  it('rejects wires to ids that are not on the canvas', async () => {
    const res = await executeTool('add_wire', {
      start_component: 'nonexistent-99',
      start_pin: 'A',
      end_component: 'led-red-1',
      end_pin: 'C',
    });
    expect(res.isError).toBe(true);
    expect(res.result).toContain('not on the canvas');
  });

  it('adds a wire between existing parts and recalculates', async () => {
    const boardId = useSimulatorStore.getState().activeBoardId!;
    const res = await executeTool('add_wire', {
      start_component: boardId,
      start_pin: '13',
      end_component: 'led-red-1',
      end_pin: 'A',
      color: 'yellow',
    });
    expect(res.isError).toBe(false);
    const wire = useSimulatorStore
      .getState()
      .wires.find((w) => w.start.componentId === boardId && w.end.componentId === 'led-red-1');
    expect(wire).toBeTruthy();
    expect(wire!.color).toBe('yellow');
  });

  it('removes a component', async () => {
    await executeTool('add_component', { type: 'led-red', x: 600, y: 100, id: 'led-tmp' });
    const res = await executeTool('remove_component', { id: 'led-tmp' });
    expect(res.isError).toBe(false);
    expect(useSimulatorStore.getState().components.some((c) => c.id === 'led-tmp')).toBe(false);
  });
});

describe('agent tools — files', () => {
  it('creates and overwrites files in the active board group', async () => {
    const create = await executeTool('write_file', {
      name: 'sketch.ino',
      content: 'void setup(){}\nvoid loop(){}\n',
    });
    expect(create.isError).toBe(false);

    const overwrite = await executeTool('write_file', {
      name: 'sketch.ino',
      content: '// v2\nvoid setup(){}\nvoid loop(){}\n',
    });
    expect(overwrite.isError).toBe(false);
    expect(overwrite.result).toContain('Overwrote');

    const board = useSimulatorStore
      .getState()
      .boards.find((b) => b.id === useSimulatorStore.getState().activeBoardId)!;
    const file = useEditorStore
      .getState()
      .getGroupFiles(board.activeFileGroupId)
      .find((f) => f.name === 'sketch.ino');
    expect(file!.content).toContain('// v2');
  });

  it('edit_file replaces a unique fragment and rejects ambiguous ones', async () => {
    await executeTool('write_file', {
      name: 'sketch.ino',
      content: 'delay(1000);\ndigitalWrite(13, HIGH);\ndelay(1000);\n',
    });

    const ambiguous = await executeTool('edit_file', {
      name: 'sketch.ino',
      old_str: 'delay(1000);',
      new_str: 'delay(200);',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.result).toContain('2 times');

    const unique = await executeTool('edit_file', {
      name: 'sketch.ino',
      old_str: 'digitalWrite(13, HIGH);\ndelay(1000);',
      new_str: 'digitalWrite(13, HIGH);\ndelay(200);',
    });
    expect(unique.isError).toBe(false);

    const missing = await executeTool('edit_file', {
      name: 'sketch.ino',
      old_str: 'not in the file at all',
      new_str: 'x',
    });
    expect(missing.isError).toBe(true);
    expect(missing.result).toContain('not found');
  });

  it('deletes files', async () => {
    await executeTool('write_file', { name: 'helper.h', content: '// h' });
    const res = await executeTool('delete_file', { name: 'helper.h' });
    expect(res.isError).toBe(false);
    const board = useSimulatorStore
      .getState()
      .boards.find((b) => b.id === useSimulatorStore.getState().activeBoardId)!;
    expect(
      useEditorStore
        .getState()
        .getGroupFiles(board.activeFileGroupId)
        .some((f) => f.name === 'helper.h'),
    ).toBe(false);
  });
});

describe('project snapshot', () => {
  it('contains boards, components, wires and file contents', () => {
    const snap = buildProjectSnapshot();
    expect(snap).toContain('BOARDS:');
    expect(snap).toContain('led-red-1');
    expect(snap).toContain('sketch.ino');
    expect(snap).toContain('digitalWrite(13, HIGH);');
    expect(snap).toContain('WIRES:');
  });
});

describe('trimHistory', () => {
  const text = (t: string) => ({ type: 'text' as const, text: t });
  it('keeps short histories untouched', () => {
    const h: ApiMessage[] = [
      { role: 'user', content: [text('a')] },
      { role: 'assistant', content: [text('b')] },
    ];
    expect(trimHistory(h, 10)).toHaveLength(2);
  });

  it('cuts only at real user-turn boundaries', () => {
    const h: ApiMessage[] = [];
    for (let i = 0; i < 10; i++) {
      h.push({ role: 'user', content: [text(`u${i}`)] });
      h.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'get_project', input: {} }],
      });
      h.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
      });
      h.push({ role: 'assistant', content: [text(`a${i}`)] });
    }
    const trimmed = trimHistory(h, 10);
    expect(trimmed.length).toBeLessThanOrEqual(12);
    // Must start at a real user turn (text first block), never at a tool_result
    expect(trimmed[0].role).toBe('user');
    expect(trimmed[0].content[0].type).toBe('text');
  });
});
