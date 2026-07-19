/**
 * Agent loop tests — runTurn() against a mocked backend SSE stream.
 *
 * Scripts a two-round conversation: the "model" first calls the get_project
 * tool (input streamed as split JSON deltas), then ends the turn with text.
 * Exercises SSE frame parsing, delta accumulation, tool execution, and the
 * tool_result → follow-up request loop.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTurn } from '../agent/AgentRunner';
import type { ApiMessage } from '../agent/types';

function sse(events: object[]): Response {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const toolUseRound = [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我先看看' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '当前项目。' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'tu_1', name: 'get_project', input: {} },
  },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
  { type: 'velxio_done' },
];

const finalRound = [
  { type: 'message_start' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成了!' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
  { type: 'velxio_done' },
];

afterEach(() => vi.restoreAllMocks());

describe('runTurn', () => {
  it('streams text, executes tools, loops, and returns API-shaped messages', async () => {
    const bodies: string[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        call += 1;
        return call === 1 ? sse(toolUseRound) : sse(finalRound);
      }),
    );

    const history: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '<project_state>x</project_state>\n做个东西' }] },
    ];

    const textDeltas: string[] = [];
    const toolsRun: string[] = [];
    const { appended, aborted } = await runTurn(history, {}, new AbortController().signal, {
      onTextBlockStart: () => {},
      onTextDelta: (d) => textDeltas.push(d),
      onToolStart: (_id, name) => toolsRun.push(name),
      onToolEnd: () => {},
    });

    expect(aborted).toBe(false);
    expect(textDeltas.join('')).toBe('我先看看当前项目。完成了!');
    expect(toolsRun).toEqual(['get_project']);

    // appended: assistant(tool_use) + user(tool_result) + assistant(final)
    expect(appended).toHaveLength(3);
    expect(appended[0].role).toBe('assistant');
    expect(appended[0].content.some((b) => b.type === 'tool_use')).toBe(true);
    expect(appended[1].role).toBe('user');
    const tr = appended[1].content[0];
    expect(tr.type).toBe('tool_result');
    if (tr.type === 'tool_result') {
      expect(tr.tool_use_id).toBe('tu_1');
      expect(tr.content).toContain('BOARDS:'); // real snapshot ran
    }
    expect(appended[2].content[0]).toEqual({ type: 'text', text: '完成了!' });

    // Second request must replay the assistant tool_use turn + tool_result
    const second = JSON.parse(bodies[1]);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].role).toBe('assistant');
    expect(second.messages[2].content[0].type).toBe('tool_result');
    expect(second.tools.length).toBeGreaterThan(10);
    expect(typeof second.system).toBe('string');
  });

  it('surfaces backend velxio_error events as thrown errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([{ type: 'velxio_error', status: 529, message: 'overloaded' }])),
    );
    await expect(
      runTurn(
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        {},
        new AbortController().signal,
        {
          onTextBlockStart: () => {},
          onTextDelta: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
        },
      ),
    ).rejects.toThrow('overloaded');
  });
});
