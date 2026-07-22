/**
 * Client-side agent loop.
 *
 * One `runTurn()` call = one full assistant turn: it repeatedly
 *   1. POSTs the conversation to the backend proxy (/api/agent/stream),
 *   2. accumulates the streamed Anthropic SSE events into content blocks,
 *   3. executes any tool_use blocks against the local stores,
 *   4. appends tool_results and loops — until the model stops calling tools.
 *
 * The raw API-shaped history (including thinking blocks + signatures, echoed
 * back verbatim as the API requires) lives here; the store keeps a parallel
 * UI-friendly rendering.
 */

import { getApiBase } from '../lib/apiBase';
import { executeTool, TOOL_DEFINITIONS } from './tools';
import { SYSTEM_PROMPT } from './systemPrompt';
import type { AgentEventHandler } from './events';
import type {
  ApiContentBlock,
  ApiMessage,
  ApiToolUseBlock,
  ToolDefinition,
} from './types';

const MAX_ITERATIONS = 40;

/** Endpoint settings from the panel (all optional — server env fills gaps).
 *  OpenAI-compatible endpoints only. */
export interface AgentSettings {
  baseUrl?: string;
  model?: string;
  effort?: string;
  apiKey?: string;
  /** Model context budget used to trigger LLM compaction (default 100k). */
  contextLimitTokens?: number;
}

interface StreamedMessage {
  content: ApiContentBlock[];
  stopReason: string | null;
}

/** Parse one backend SSE stream into a complete assistant message. */
async function streamOneMessage(
  messages: ApiMessage[],
  settings: AgentSettings,
  signal: AbortSignal,
  onEvent: AgentEventHandler,
  system: string = SYSTEM_PROMPT,
  tools: ToolDefinition[] = TOOL_DEFINITIONS,
): Promise<StreamedMessage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;

  const resp = await fetch(`${getApiBase()}/agent/stream`, {
    method: 'POST',
    headers,
    credentials: 'include',
    signal,
    body: JSON.stringify({
      system,
      messages,
      tools,
      base_url: settings.baseUrl || undefined,
      model: settings.model || undefined,
      effort: settings.effort || undefined,
    }),
  });

  if (!resp.ok || !resp.body) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = j.detail ?? detail;
    } catch {
      /* keep status */
    }
    throw new Error(detail);
  }

  const content: ApiContentBlock[] = [];
  // Per-index accumulation scratch (tool_use input arrives as JSON deltas)
  const partialJson: Record<number, string> = {};
  let stopReason: string | null = null;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (ev: Record<string, unknown>) => {
    switch (ev.type) {
      case 'content_block_start': {
        const idx = ev.index as number;
        const block = ev.content_block as Record<string, unknown>;
        if (block.type === 'text') {
          content[idx] = { type: 'text', text: '' };
          onEvent({ type: 'text_block_start' });
        } else if (block.type === 'thinking') {
          content[idx] = { type: 'thinking', thinking: '' };
        } else if (block.type === 'tool_use') {
          content[idx] = {
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            input: {},
          };
          partialJson[idx] = '';
        }
        break;
      }
      case 'content_block_delta': {
        const idx = ev.index as number;
        const delta = ev.delta as Record<string, unknown>;
        const block = content[idx];
        if (!block) break;
        if (delta.type === 'text_delta' && block.type === 'text') {
          block.text += delta.text as string;
          onEvent({ type: 'text_delta', delta: delta.text as string });
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          block.thinking += (delta.thinking as string) ?? '';
        } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
          block.signature = ((block.signature ?? '') + (delta.signature as string)) as string;
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          partialJson[idx] += (delta.partial_json as string) ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const idx = ev.index as number;
        const block = content[idx];
        if (block?.type === 'tool_use' && partialJson[idx] !== undefined) {
          try {
            block.input = partialJson[idx] ? JSON.parse(partialJson[idx]) : {};
          } catch {
            block.input = {};
          }
          delete partialJson[idx];
        }
        break;
      }
      case 'message_delta': {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason as string;
        break;
      }
      case 'velxio_thinking':
        onEvent({ type: 'thinking_progress', chars: Number(ev.chars) || 0 });
        break;
      case 'velxio_usage':
        onEvent({
          type: 'usage',
          promptTokens: Number(ev.prompt_tokens) || 0,
          completionTokens: Number(ev.completion_tokens) || 0,
        });
        break;
      case 'velxio_error':
        throw new Error(String(ev.message ?? 'stream error'));
      default:
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; each frame is `data: {json}`
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        handleEvent(ev);
      }
    }
  }

  // Drop empty trailing text blocks / holes
  const cleaned = content.filter(
    (b) =>
      b &&
      !(b.type === 'text' && b.text === '') &&
      !(b.type === 'thinking' && b.thinking === '' && !b.signature),
  );
  return { content: cleaned, stopReason };
}

/**
 * One tool-less completion over an arbitrary system prompt — used by context
 * compaction to summarize dropped turns through the same proxy endpoint.
 * Returns the concatenated assistant text.
 */
export async function streamText(
  messages: ApiMessage[],
  settings: AgentSettings,
  signal: AbortSignal,
  system: string,
): Promise<string> {
  const msg = await streamOneMessage(messages, settings, signal, () => {}, system, []);
  return msg.content
    .filter((b): b is Extract<ApiContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export interface RunTurnResult {
  /** Full API-shaped messages appended during this turn (assistant + tool results) */
  appended: ApiMessage[];
  aborted: boolean;
  /** Stream failure that happened AFTER partial work was appended. The caller
   *  must still commit `appended` (tools already mutated the project) and show
   *  the error — but must NOT arm retry, which would re-run the request. */
  error?: string;
  /** True when the turn stopped because it hit the iteration cap — the UI
   *  offers a "continue" action instead of pretending the model finished. */
  capped?: boolean;
}

/** How many LLM calls before the cap to warn the model to wrap up. */
const CAP_WARNING_MARGIN = 4;
/** Hard ceiling on LLM calls per run, across steering-promoted turns. */
const MAX_TOTAL_CALLS = 120;

const CAP_WARNING_NOTE =
  '[system note] You are approaching the per-turn step limit. Wrap up: finish the most ' +
  'important remaining action, then summarize what is done and what remains.';

export interface RunTurnOptions {
  /** Steering queue — drained after each tool batch and at turn end. */
  steering?: { drain(): string[] };
  /** Build a full user turn (fresh snapshot + example hint) when queued
   *  steering is promoted to a follow-up turn at what would be the end. */
  buildFollowUpTurn?: (text: string) => ApiMessage;
  /** Wire-side context transform applied before EVERY LLM call (stale-snapshot
   *  stripping, structural trim). Must not mutate its input. */
  transformContext?: (messages: ApiMessage[]) => ApiMessage[];
}

/**
 * Run one assistant turn. `history` must already end with the new user
 * message. Returns the messages to append to the persistent history.
 */
export async function runTurn(
  history: ApiMessage[],
  settings: AgentSettings,
  signal: AbortSignal,
  onEvent: AgentEventHandler,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const appended: ApiMessage[] = [];
  const working = [...history];
  onEvent({ type: 'run_start' });

  const end = (result: RunTurnResult): RunTurnResult => {
    onEvent({
      type: 'run_end',
      reason: result.capped ? 'iteration_cap' : result.aborted ? 'aborted' : result.error ? 'error' : 'done',
      error: result.error,
    });
    return result;
  };

  let iteration = 0; // resets when steering promotes a follow-up turn
  let totalCalls = 0;

  for (;;) {
    if (iteration >= MAX_ITERATIONS || totalCalls >= MAX_TOTAL_CALLS) {
      // Cap reached — return what we have; the store surfaces a notice.
      return end({ appended, aborted: false, capped: true });
    }
    onEvent({ type: 'llm_call_start', iteration });
    iteration++;
    totalCalls++;

    let msg: StreamedMessage;
    try {
      const wire = options.transformContext ? options.transformContext(working) : working;
      msg = await streamOneMessage(wire, settings, signal, onEvent);
    } catch (err) {
      if (signal.aborted) return end({ appended, aborted: true });
      const message = err instanceof Error ? err.message : String(err);
      // Tools may already have run in earlier iterations — surface the error
      // but hand the completed work back instead of discarding it.
      if (appended.length > 0) {
        return end({ appended, aborted: false, error: message });
      }
      onEvent({ type: 'run_end', reason: 'error', error: message });
      throw err;
    }

    const assistantMsg: ApiMessage = { role: 'assistant', content: msg.content };
    appended.push(assistantMsg);
    working.push(assistantMsg);

    const toolUses = msg.content.filter((b): b is ApiToolUseBlock => b.type === 'tool_use');
    if (msg.stopReason !== 'tool_use' || toolUses.length === 0) {
      // The turn would end here. If the user queued messages while we worked,
      // promote them to a follow-up user turn and keep going.
      const queued = options.steering?.drain() ?? [];
      if (queued.length > 0 && options.buildFollowUpTurn && !signal.aborted) {
        const text = queued.join('\n\n');
        onEvent({ type: 'follow_up_turn', text });
        const followUp = options.buildFollowUpTurn(text);
        appended.push(followUp);
        working.push(followUp);
        iteration = 0;
        continue;
      }
      return end({ appended, aborted: false });
    }

    const results: ApiContentBlock[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) {
        // Every tool_use needs a paired tool_result or the upstream rejects
        // the whole history on the next request — synthesize error results
        // for the tools the abort skipped.
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Aborted by user before this tool executed.',
          is_error: true,
        });
        continue;
      }
      onEvent({ type: 'tool_start', id: tu.id, name: tu.name, input: tu.input });
      const { result, isError, diff } = await executeTool(tu.name, tu.input, {
        toolCallId: tu.id,
        signal,
        onUpdate: (detail) => onEvent({ type: 'tool_update', id: tu.id, detail }),
      });
      onEvent({ type: 'tool_end', id: tu.id, result, isError, diff });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result,
        is_error: isError || undefined,
      });
    }

    // Mid-turn steering: ride along on the tool-result user message as plain
    // text (no snapshot — the model has live tool results; a 48KB snapshot
    // here would wreck the prompt cache). The backend emits tool_result
    // blocks before text blocks of the same message, so this is wire-correct.
    if (!signal.aborted) {
      for (const text of options.steering?.drain() ?? []) {
        onEvent({ type: 'steering_injected', text });
        results.push({ type: 'text', text: `[user, interjecting mid-task] ${text}` });
      }
    }

    // Nearing the cap: tell the model (as part of the tool-result turn) so it
    // wraps up instead of getting cut off mid-plan.
    if (iteration === MAX_ITERATIONS - CAP_WARNING_MARGIN) {
      onEvent({ type: 'turn_limit_warning', remaining: CAP_WARNING_MARGIN });
      results.push({ type: 'text', text: CAP_WARNING_NOTE });
    }

    const resultMsg: ApiMessage = { role: 'user', content: results };
    appended.push(resultMsg);
    working.push(resultMsg);
    if (signal.aborted) return end({ appended, aborted: true });
  }
}

/**
 * Trim old turns so the request stays a sane size, REPLACING the dropped
 * turns with a structural summary (user requests + tool count) instead of
 * silently forgetting them. Keeps whole user-turn boundaries (never splits a
 * tool_use / tool_result pair) by only cutting at messages that are real
 * user turns (role=user whose first block is text).
 */
export function trimHistory(history: ApiMessage[], maxMessages = 36): ApiMessage[] {
  if (history.length <= maxMessages) return history;
  const overflow = history.length - maxMessages;
  // find the first real user-turn boundary at or after `overflow`
  for (let i = overflow; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' && m.content[0]?.type === 'text') {
      const dropped = history.slice(0, i);
      const summary = summarizeDropped(dropped);
      const kept = history.slice(i);
      return summary ? [summary, ...kept] : kept;
    }
  }
  return history; // no safe boundary found — keep everything
}

/** Structural (no-LLM) compaction of dropped turns: what the user asked for
 *  and how much tool work happened. Project facts live in the fresh
 *  <project_state> of the latest turn, so this only preserves intent. */
function summarizeDropped(dropped: ApiMessage[]): ApiMessage | null {
  const requests: string[] = [];
  let toolCalls = 0;
  for (const m of dropped) {
    if (m.role === 'user') {
      const first = m.content[0];
      if (first?.type === 'text') {
        // strip the injected <project_state>/<reference_example> blocks
        const text = first.text
          .replace(/<project_state>[\s\S]*?<\/project_state>\s*/g, '')
          .replace(/<reference_example>[\s\S]*?<\/reference_example>\s*/g, '')
          // a previous rolling summary is not itself a request — drop it
          .replace(/<context_summary>[\s\S]*?<\/context_summary>\s*/g, '')
          .trim();
        if (text) requests.push(text.slice(0, 80));
      }
    } else {
      toolCalls += m.content.filter((b) => b.type === 'tool_use').length;
    }
  }
  if (requests.length === 0 && toolCalls === 0) return null;
  const summary =
    `<context_summary>\n` +
    `Earlier turns were compacted. The user's previous requests, in order:\n` +
    requests.map((r, i) => `${i + 1}. ${r}`).join('\n') +
    `\n(${toolCalls} tool calls were executed for these.) ` +
    `The CURRENT project state is in the latest <project_state> block — trust it, not memory.\n` +
    `</context_summary>`;
  return { role: 'user', content: [{ type: 'text', text: summary }] };
}
