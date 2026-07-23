/**
 * applyAgentEvent() — the pure event → UI-segment reducer. Feeds a scripted
 * event list and asserts the rendered message shape (coverage the old
 * callback wiring couldn't have).
 */

import { describe, it, expect } from 'vitest';
import { applyAgentEvent } from '../agent/uiReducer';
import type { AgentEvent } from '../agent/events';
import type { UiMessage } from '../agent/types';

const run = (events: AgentEvent[]): UiMessage =>
  events.reduce(applyAgentEvent, { id: 'm1', role: 'assistant', segments: [] } as UiMessage);

describe('applyAgentEvent', () => {
  it('builds text segments from block starts and deltas', () => {
    const msg = run([
      { type: 'text_block_start' },
      { type: 'text_delta', delta: '你好' },
      { type: 'text_delta', delta: '世界' },
    ]);
    expect(msg.segments).toEqual([{ kind: 'text', text: '你好世界' }]);
  });

  it('opens a tool chip, streams progress, and closes it', () => {
    const msg = run([
      { type: 'tool_start', id: 't1', name: 'compile', input: {} },
      { type: 'tool_update', id: 't1', detail: 'Compiling core…' },
      { type: 'tool_end', id: 't1', result: 'Compile succeeded.', isError: false },
    ]);
    expect(msg.segments).toHaveLength(1);
    const seg = msg.segments[0];
    expect(seg.kind).toBe('tool');
    if (seg.kind === 'tool') {
      expect(seg.status).toBe('ok');
      expect(seg.detail).toBe('Compile succeeded.');
    }
  });

  it('interleaves text and tools like a real turn', () => {
    const msg = run([
      { type: 'text_block_start' },
      { type: 'text_delta', delta: '我来接线。' },
      { type: 'tool_start', id: 't1', name: 'add_wire', input: { start_component: 'a', start_pin: '1', end_component: 'b', end_pin: '2' } },
      { type: 'tool_end', id: 't1', result: 'Added wire', isError: false },
      { type: 'text_block_start' },
      { type: 'text_delta', delta: '完成。' },
    ]);
    expect(msg.segments.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('accumulates thinking chars and usage', () => {
    const msg = run([
      { type: 'thinking_progress', chars: 100 },
      { type: 'thinking_progress', chars: 50 },
      { type: 'usage', promptTokens: 1000, completionTokens: 20 },
      { type: 'usage', promptTokens: 1100, completionTokens: 30 },
    ]);
    expect(msg.thinkingChars).toBe(150);
    expect(msg.usage).toEqual({ input: 2100, output: 50 });
  });

  it('marks a failed tool and surfaces run errors', () => {
    const msg = run([
      { type: 'tool_start', id: 't1', name: 'compile', input: {} },
      { type: 'tool_end', id: 't1', result: 'ERROR: boom', isError: true },
      { type: 'run_end', reason: 'error', error: 'upstream died' },
    ]);
    const seg = msg.segments[0];
    if (seg.kind === 'tool') expect(seg.status).toBe('error');
    expect(msg.error).toBe('upstream died');
  });
});
