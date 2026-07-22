/**
 * Pure reducer: AgentEvent → UiMessage updates.
 *
 * Extracted from the store's callback wiring so the event → segment logic is
 * unit-testable with a scripted event list, and the store's send() is a thin
 * subscription. Token-total bookkeeping (session-level) stays in the store —
 * this reducer only shapes the assistant message being streamed.
 */

import type { AgentEvent } from './events';
import { toolLabel } from './tools';
import type { UiMessage, UiToolSegment } from './types';

const TOOL_DETAIL_BUDGET = 2000;

export function applyAgentEvent(msg: UiMessage, ev: AgentEvent): UiMessage {
  switch (ev.type) {
    case 'text_block_start':
      return { ...msg, segments: [...msg.segments, { kind: 'text', text: '' }] };

    case 'text_delta': {
      const segments = [...msg.segments];
      const last = segments[segments.length - 1];
      if (last?.kind === 'text') {
        segments[segments.length - 1] = { ...last, text: last.text + ev.delta };
      } else {
        segments.push({ kind: 'text', text: ev.delta });
      }
      return { ...msg, segments };
    }

    case 'thinking_progress':
      return { ...msg, thinkingChars: (msg.thinkingChars ?? 0) + ev.chars };

    case 'usage':
      return {
        ...msg,
        usage: {
          input: (msg.usage?.input ?? 0) + ev.promptTokens,
          output: (msg.usage?.output ?? 0) + ev.completionTokens,
        },
      };

    case 'tool_start':
      return {
        ...msg,
        segments: [
          ...msg.segments,
          {
            kind: 'tool',
            name: ev.name,
            label: toolLabel(ev.name, ev.input),
            status: 'running',
          } satisfies UiToolSegment,
        ],
      };

    case 'tool_update':
      return patchRunningTool(msg, (seg) => ({
        ...seg,
        detail: ev.detail.slice(-TOOL_DETAIL_BUDGET),
      }));

    case 'tool_end':
      return patchRunningTool(msg, (seg) => ({
        ...seg,
        status: ev.isError ? 'error' : 'ok',
        detail: ev.result.slice(0, TOOL_DETAIL_BUDGET),
        diff: ev.diff,
      }));

    case 'run_end':
      return ev.reason === 'error' && ev.error ? { ...msg, error: ev.error } : msg;

    case 'compaction_end':
      return ev.ok
        ? { ...msg, segments: [...msg.segments, { kind: 'notice', notice: 'compaction' }] }
        : msg;

    // Session-level / no-segment events (steering bubbles are created
    // structurally by the store, not by patching the assistant message)
    case 'run_start':
    case 'llm_call_start':
    case 'compaction_start':
    case 'turn_limit_warning':
    case 'steering_injected':
    case 'follow_up_turn':
      return msg;
  }
}

function patchRunningTool(
  msg: UiMessage,
  fn: (seg: UiToolSegment) => UiToolSegment,
): UiMessage {
  const segments = [...msg.segments];
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind === 'tool' && seg.status === 'running') {
      segments[i] = fn(seg);
      return { ...msg, segments };
    }
  }
  return msg;
}
