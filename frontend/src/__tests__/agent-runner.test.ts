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
import type { AgentEvent } from '../agent/events';
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

    const events: AgentEvent[] = [];
    const { appended, aborted } = await runTurn(history, {}, new AbortController().signal, (ev) =>
      events.push(ev),
    );

    expect(aborted).toBe(false);
    const textDeltas = events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
    expect(textDeltas.join('')).toBe('我先看看当前项目。完成了!');
    const toolsRun = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
    expect(toolsRun).toEqual(['get_project']);
    expect(events[0].type).toBe('run_start');
    expect(events[events.length - 1]).toEqual({ type: 'run_end', reason: 'done', error: undefined });

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

  it('abort mid-batch still pairs every tool_use with a tool_result', async () => {
    const twoToolRound = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_a', name: 'get_project', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_b', name: 'get_project', input: {} },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sse(twoToolRound)));

    const controller = new AbortController();
    const executed: string[] = [];
    const { appended, aborted } = await runTurn(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      {},
      controller.signal,
      (ev) => {
        if (ev.type === 'tool_start') {
          executed.push(ev.id);
          controller.abort(); // user hits stop while the first tool runs
        }
      },
    );

    expect(aborted).toBe(true);
    expect(executed).toEqual(['tu_a']); // second tool never ran
    // assistant(tool_use x2) + user(tool_result x2) — pair-complete
    expect(appended).toHaveLength(2);
    const results = appended[1].content;
    expect(results.map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''))).toEqual([
      'tu_a',
      'tu_b',
    ]);
    const skipped = results[1];
    if (skipped.type === 'tool_result') {
      expect(skipped.is_error).toBe(true);
      expect(skipped.content).toContain('Aborted');
    }
  });

  it('injects steering mid-turn and promotes queued messages to follow-up turns', async () => {
    const bodies: string[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        call += 1;
        // round 1: tool call; round 2: end turn; round 3 (follow-up): end turn
        return call === 1 ? sse(toolUseRound) : sse(finalRound);
      }),
    );

    const queue: string[] = ['换成黄色 LED'];
    let followUpQueued = false;
    const events: AgentEvent[] = [];

    const { appended } = await runTurn(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      {},
      new AbortController().signal,
      (ev) => {
        events.push(ev);
        // Queue a follow-up while the (second) model call streams its final text
        if (ev.type === 'text_delta' && !followUpQueued && call === 2) {
          followUpQueued = true;
          queue.push('再加一个按钮');
        }
      },
      {
        steering: { drain: () => queue.splice(0) },
        buildFollowUpTurn: (text) => ({
          role: 'user',
          content: [{ type: 'text', text: `<project_state>fresh</project_state>\n${text}` }],
        }),
      },
    );

    // Mid-turn steering rode along on the tool-result user message as text
    const resultMsg = appended[1];
    expect(resultMsg.role).toBe('user');
    expect(resultMsg.content[0].type).toBe('tool_result');
    const steerBlock = resultMsg.content.find((b) => b.type === 'text');
    expect(steerBlock && steerBlock.type === 'text' ? steerBlock.text : '').toContain(
      '换成黄色 LED',
    );
    expect(events.some((e) => e.type === 'steering_injected')).toBe(true);

    // The queued follow-up became a full user turn and the loop continued
    expect(events.some((e) => e.type === 'follow_up_turn')).toBe(true);
    const followUp = appended.find(
      (m) =>
        m.role === 'user' &&
        m.content[0]?.type === 'text' &&
        m.content[0].text.includes('再加一个按钮'),
    );
    expect(followUp).toBeTruthy();
    expect(call).toBe(3); // tool round + would-end round + follow-up round
  });

  it('returns partial work with an error when the stream dies after tools ran', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? sse(toolUseRound)
          : sse([{ type: 'velxio_error', status: 500, message: 'upstream exploded' }]);
      }),
    );

    const { appended, aborted, error } = await runTurn(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      {},
      new AbortController().signal,
      () => {},
    );

    expect(aborted).toBe(false);
    expect(error).toContain('upstream exploded');
    // assistant(tool_use) + user(tool_result) survive for the commit
    expect(appended).toHaveLength(2);
    expect(appended[1].content[0].type).toBe('tool_result');
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
        () => {},
      ),
    ).rejects.toThrow('overloaded');
  });
});
