/**
 * Tests for the AI assistant's v2 features: line diffs, history compaction
 * summaries, example-grounded prompting, and per-turn project checkpoints.
 */

import { describe, it, expect } from 'vitest';
import { lineDiff } from '../agent/diff';
import { trimHistory } from '../agent/AgentRunner';
import { buildExampleHint } from '../agent/exampleHints';
import { captureCheckpoint, restoreCheckpoint } from '../agent/checkpoint';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import type { ApiMessage } from '../agent/types';

describe('lineDiff', () => {
  it('shows only the changed middle with -/+ markers', () => {
    const oldT = 'a\nb\nc\nd';
    const newT = 'a\nB2\nc\nd';
    const d = lineDiff(oldT, newT);
    expect(d).toContain('@@ line 2');
    expect(d).toContain('- b');
    expect(d).toContain('+ B2');
    expect(d).not.toContain('- a');
    expect(d).not.toContain('+ c');
  });

  it('returns empty for identical inputs and all-adds for new files', () => {
    expect(lineDiff('same', 'same')).toBe('');
    const d = lineDiff('', 'x\ny');
    expect(d).toContain('+ x');
    expect(d).toContain('+ y');
  });
});

describe('trimHistory compaction summary', () => {
  const text = (t: string) => ({ type: 'text' as const, text: t });

  it('replaces dropped turns with a structural summary', () => {
    const h: ApiMessage[] = [];
    for (let i = 0; i < 12; i++) {
      h.push({
        role: 'user',
        content: [text(`<project_state>stuff${i}</project_state>\n\n请求${i}`)],
      });
      h.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'compile', input: {} }],
      });
      h.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
      });
      h.push({ role: 'assistant', content: [text(`答复${i}`)] });
    }
    const trimmed = trimHistory(h, 12);
    const first = trimmed[0];
    expect(first.role).toBe('user');
    expect(first.content[0].type).toBe('text');
    if (first.content[0].type === 'text') {
      expect(first.content[0].text).toContain('<context_summary>');
      expect(first.content[0].text).toContain('请求0');
      // injected snapshot CONTENT must not leak into the summary (the literal
      // tag name appears in the "trust the latest <project_state>" note)
      expect(first.content[0].text).not.toContain('stuff');
      expect(first.content[0].text).toMatch(/\d+ tool calls/);
    }
    // Roughly bounded: summary + kept window
    expect(trimmed.length).toBeLessThanOrEqual(14);
    // Second message must be a real user turn
    expect(trimmed[1].role).toBe('user');
    expect(trimmed[1].content[0].type).toBe('text');
  });

  it('does not recursively embed old summaries', () => {
    const first = trimHistory(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? ({ role: 'user', content: [text(`req${i}`)] } as ApiMessage)
          : ({ role: 'assistant', content: [text(`a${i}`)] } as ApiMessage),
      ),
      10,
    );
    const second = trimHistory([...first, ...Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? ({ role: 'user', content: [text(`late${i}`)] } as ApiMessage)
        : ({ role: 'assistant', content: [text(`b${i}`)] } as ApiMessage),
    )], 10);
    const summaryText =
      second[0].content[0].type === 'text' ? second[0].content[0].text : '';
    // The new summary must not quote the previous <context_summary> wholesale
    expect(summaryText.match(/<context_summary>/g)?.length).toBe(1);
  });
});

describe('buildExampleHint', () => {
  it('finds a reference example for a classic beginner request', () => {
    const hint = buildExampleHint('让 LED 闪烁 blink');
    expect(hint).toContain('<reference_example>');
    expect(hint).toContain('title:');
    expect(hint.length).toBeLessThan(3200);
  });

  it('maps Chinese component names to catalog keywords', () => {
    const hint = buildExampleHint('用超声波传感器测距');
    expect(hint).toContain('<reference_example>');
    expect(hint.toLowerCase()).toMatch(/ultrasonic|hc-sr04|distance/);
  });

  it('returns empty for unmatched requests', () => {
    expect(buildExampleHint('qq zz xy')).toBe('');
  });
});

describe('project checkpoint', () => {
  it('captures and restores boards, components, wires and files', async () => {
    const sim = useSimulatorStore.getState();

    // Build a known baseline
    for (const b of [...useSimulatorStore.getState().boards]) sim.removeBoard(b.id);
    const boardId = useSimulatorStore.getState().addBoard('arduino-uno', 30, 40);
    useSimulatorStore.getState().setActiveBoardId(boardId);
    useSimulatorStore.getState().setComponents([
      { id: 'cp-led', metadataId: 'led-red', x: 300, y: 100, properties: { color: 'red' } },
    ]);
    useSimulatorStore.getState().setWires([
      {
        id: 'cp-wire',
        start: { componentId: boardId, pinName: '13', x: 0, y: 0 },
        end: { componentId: 'cp-led', pinName: 'A', x: 0, y: 0 },
        color: 'green',
        waypoints: [],
      },
    ]);
    const board = useSimulatorStore.getState().boards.find((b) => b.id === boardId)!;
    useEditorStore.getState().replaceFileGroups({
      [board.activeFileGroupId]: [{ name: 'sketch.ino', content: '// baseline v1' }],
    });

    const cp = captureCheckpoint();

    // Wreck everything, as a rogue AI turn might
    useSimulatorStore.getState().setComponents([]);
    useSimulatorStore.getState().setWires([]);
    useSimulatorStore.getState().removeBoard(boardId);
    useSimulatorStore.getState().addBoard('arduino-mega', 10, 10);

    await restoreCheckpoint(cp);

    const after = useSimulatorStore.getState();
    expect(after.boards).toHaveLength(1);
    expect(after.boards[0].id).toBe(boardId);
    expect(after.boards[0].boardKind).toBe('arduino-uno');
    expect(after.components.map((c) => c.id)).toEqual(['cp-led']);
    expect(after.wires.map((w) => w.id)).toEqual(['cp-wire']);
    const files = useEditorStore.getState().getGroupFiles(after.boards[0].activeFileGroupId);
    expect(files.map((f) => [f.name, f.content])).toEqual([['sketch.ino', '// baseline v1']]);
  });
});
