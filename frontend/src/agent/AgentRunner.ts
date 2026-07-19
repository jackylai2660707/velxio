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
import type { ApiContentBlock, ApiMessage, ApiToolUseBlock } from './types';

const MAX_ITERATIONS = 40;

/** Provider settings from the panel (all optional — server env fills gaps). */
export interface AgentSettings {
  provider?: 'openai' | 'anthropic';
  baseUrl?: string;
  model?: string;
  effort?: string;
  apiKey?: string;
}

export interface RunnerCallbacks {
  /** Streamed assistant text delta */
  onTextDelta: (delta: string) => void;
  /** A new text block started (UI should open a new text segment) */
  onTextBlockStart: () => void;
  /** Tool call is about to execute */
  onToolStart: (id: string, name: string, input: Record<string, unknown>) => void;
  /** Tool call finished */
  onToolEnd: (id: string, result: string, isError: boolean) => void;
  /** Reasoning-model progress: `chars` more characters of hidden reasoning
   *  were generated (openai provider only; keeps the UI alive during long
   *  thinking phases). */
  onThinking?: (chars: number) => void;
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
  cb: RunnerCallbacks,
): Promise<StreamedMessage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;

  const resp = await fetch(`${getApiBase()}/agent/stream`, {
    method: 'POST',
    headers,
    credentials: 'include',
    signal,
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOL_DEFINITIONS,
      provider: settings.provider || undefined,
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
          cb.onTextBlockStart();
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
          cb.onTextDelta(delta.text as string);
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
        cb.onThinking?.(Number(ev.chars) || 0);
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

export interface RunTurnResult {
  /** Full API-shaped messages appended during this turn (assistant + tool results) */
  appended: ApiMessage[];
  aborted: boolean;
}

/**
 * Run one assistant turn. `history` must already end with the new user
 * message. Returns the messages to append to the persistent history.
 */
export async function runTurn(
  history: ApiMessage[],
  settings: AgentSettings,
  signal: AbortSignal,
  cb: RunnerCallbacks,
): Promise<RunTurnResult> {
  const appended: ApiMessage[] = [];
  const working = [...history];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let msg: StreamedMessage;
    try {
      msg = await streamOneMessage(working, settings, signal, cb);
    } catch (err) {
      if (signal.aborted) return { appended, aborted: true };
      throw err;
    }

    const assistantMsg: ApiMessage = { role: 'assistant', content: msg.content };
    appended.push(assistantMsg);
    working.push(assistantMsg);

    const toolUses = msg.content.filter((b): b is ApiToolUseBlock => b.type === 'tool_use');
    if (msg.stopReason !== 'tool_use' || toolUses.length === 0) {
      return { appended, aborted: false };
    }

    const results: ApiContentBlock[] = [];
    for (const tu of toolUses) {
      if (signal.aborted) return { appended, aborted: true };
      cb.onToolStart(tu.id, tu.name, tu.input);
      const { result, isError } = await executeTool(tu.name, tu.input);
      cb.onToolEnd(tu.id, result, isError);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result,
        is_error: isError || undefined,
      });
    }

    const resultMsg: ApiMessage = { role: 'user', content: results };
    appended.push(resultMsg);
    working.push(resultMsg);
  }

  // Iteration cap reached — return what we have; the store surfaces a notice.
  return { appended, aborted: false };
}

/**
 * Trim old turns so the request stays a sane size. Keeps whole user-turn
 * boundaries (never splits a tool_use / tool_result pair) by only cutting at
 * messages that are real user turns (role=user whose first block is text).
 */
export function trimHistory(history: ApiMessage[], maxMessages = 36): ApiMessage[] {
  if (history.length <= maxMessages) return history;
  const overflow = history.length - maxMessages;
  // find the first real user-turn boundary at or after `overflow`
  for (let i = overflow; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' && m.content[0]?.type === 'text') {
      return history.slice(i);
    }
  }
  return history; // no safe boundary found — keep everything
}
