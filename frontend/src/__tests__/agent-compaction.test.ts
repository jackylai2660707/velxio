/**
 * Context-management tests: stale-snapshot stripping, compaction trigger
 * threshold, and LLM summarization (mocked SSE) with silent fallback.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  stripStaleSnapshots,
  shouldCompact,
  compactHistory,
  estimateTokens,
} from '../agent/compaction';
import type { ApiMessage } from '../agent/types';

const turn = (text: string, withSnapshot = true): ApiMessage => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: withSnapshot ? `<project_state>\nBOARDS: x\n</project_state>\n\n${text}` : text,
    },
  ],
});
const assistant = (text: string): ApiMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

afterEach(() => vi.restoreAllMocks());

describe('stripStaleSnapshots', () => {
  it('strips snapshots from all but the latest real user turn', () => {
    const msgs = [turn('第一件事'), assistant('ok'), turn('第二件事')];
    const out = stripStaleSnapshots(msgs);
    const first = out[0].content[0];
    const last = out[2].content[0];
    if (first.type === 'text') {
      expect(first.text).not.toContain('BOARDS: x'); // snapshot body gone
      expect(first.text).toContain('第一件事');
      expect(first.text).toContain('omitted');
    }
    expect(last.type === 'text' && last.text).toContain('BOARDS: x');
    expect(out[1]).toBe(msgs[1]); // untouched messages keep identity
  });
});

describe('shouldCompact', () => {
  it('uses reported prompt tokens against the threshold', () => {
    expect(shouldCompact([], 80_000, 100_000)).toBe(true);
    expect(shouldCompact([], 40_000, 100_000)).toBe(false);
  });

  it('falls back to a size estimate when no usage was reported', () => {
    const big = [turn('x'.repeat(400_000), false)];
    expect(estimateTokens(big)).toBeGreaterThan(75_000);
    expect(shouldCompact(big, 0, 100_000)).toBe(true);
    expect(shouldCompact([turn('hi', false)], 0, 100_000)).toBe(false);
  });
});

describe('compactHistory', () => {
  const history: ApiMessage[] = [
    turn('搭红绿灯'),
    assistant('好的,搭好了'),
    turn('加个按钮'),
    assistant('加好了'),
    turn('再加蜂鸣器'),
    assistant('完成'),
  ];

  const sse = (events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

  it('replaces old turns with a <context_summary> message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '用户搭了红绿灯并加了按钮,LED 在 13 号引脚。' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ),
    );

    const out = await compactHistory(history, {});
    expect(out).not.toBe(history);
    // keeps the last two real user turns; everything earlier becomes summary
    const first = out[0].content[0];
    expect(first.type === 'text' && first.text).toContain('<context_summary>');
    expect(first.type === 'text' && first.text).toContain('红绿灯');
    expect(out).toHaveLength(1 + 4); // summary + (turn,assistant)x2
    const kept = out[1].content[0];
    expect(kept.type === 'text' && kept.text).toContain('加个按钮');
  });

  it('returns the input unchanged when the summary call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const out = await compactHistory(history, {});
    expect(out).toBe(history);
  });

  it('does nothing when there are too few turns', async () => {
    const short = history.slice(0, 3);
    const out = await compactHistory(short, {});
    expect(out).toBe(short);
  });
});
