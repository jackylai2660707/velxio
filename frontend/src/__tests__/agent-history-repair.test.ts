/**
 * repairHistory() — pair-completeness repair for the agent's API history.
 * Covers the three real-world corruption modes: abort mid-batch, page reload
 * mid-run (dangling tool_use persisted), and orphan tool_results.
 */

import { describe, it, expect } from 'vitest';
import { repairHistory } from '../agent/historyRepair';
import type { ApiMessage } from '../agent/types';

const user = (text: string): ApiMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantWithTools = (...ids: string[]): ApiMessage => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use' as const, id, name: 'get_project', input: {} })),
});
const resultMsg = (...ids: string[]): ApiMessage => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })),
});

describe('repairHistory', () => {
  it('returns the same reference when the history is already pair-complete', () => {
    const history = [user('hi'), assistantWithTools('tu_1'), resultMsg('tu_1')];
    expect(repairHistory(history)).toBe(history);
  });

  it('inserts synthetic results for a dangling tool_use before a plain user turn', () => {
    const history = [user('hi'), assistantWithTools('tu_1'), user('are you stuck?')];
    const repaired = repairHistory(history);
    expect(repaired).toHaveLength(4);
    const inserted = repaired[2];
    expect(inserted.role).toBe('user');
    const block = inserted.content[0];
    expect(block.type).toBe('tool_result');
    if (block.type === 'tool_result') {
      expect(block.tool_use_id).toBe('tu_1');
      expect(block.is_error).toBe(true);
    }
    expect(repaired[3]).toBe(history[2]);
  });

  it('appends synthetic results for a dangling tool_use at the end (reload mid-run)', () => {
    const history = [user('hi'), assistantWithTools('tu_1', 'tu_2')];
    const repaired = repairHistory(history);
    expect(repaired).toHaveLength(3);
    const ids = repaired[2].content.map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''));
    expect(ids).toEqual(['tu_1', 'tu_2']);
  });

  it('completes a result message that answered only part of the batch', () => {
    const history = [user('hi'), assistantWithTools('tu_1', 'tu_2'), resultMsg('tu_2')];
    const repaired = repairHistory(history);
    expect(repaired).toHaveLength(3);
    const blocks = repaired[2].content;
    expect(blocks).toHaveLength(2);
    const first = blocks[0];
    if (first.type === 'tool_result') {
      expect(first.tool_use_id).toBe('tu_1');
      expect(first.is_error).toBe(true);
    }
    const second = blocks[1];
    if (second.type === 'tool_result') {
      expect(second.tool_use_id).toBe('tu_2');
      expect(second.content).toBe('ok');
    }
  });

  it('drops orphan tool_results whose tool_use is gone', () => {
    const history = [user('hi'), resultMsg('tu_ghost'), user('again')];
    const repaired = repairHistory(history);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toBe(history[0]);
    expect(repaired[1]).toBe(history[2]);
  });
});
