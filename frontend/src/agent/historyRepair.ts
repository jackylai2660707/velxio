/**
 * History integrity repair.
 *
 * The wire format requires every assistant `tool_use` block to be answered by
 * a `tool_result` block in the immediately-following user message. An abort,
 * stream error, or page reload mid-run can leave the persisted history with
 * dangling tool_use blocks (the upstream then rejects every subsequent
 * request with a 400) or with orphan tool_results whose tool_use is gone.
 *
 * `repairHistory` walks the history and makes it pair-complete:
 *  - dangling tool_use  → a synthetic `is_error` tool_result is inserted
 *  - orphan tool_result → the block is dropped (its message too, if emptied)
 *
 * Returns the input array unchanged (same reference) when nothing needed
 * fixing, so callers can cheaply detect "no repair happened".
 */

import type { ApiContentBlock, ApiMessage } from './types';

const INTERRUPTED_NOTE =
  'Tool execution was interrupted (abort or page reload); no result was recorded.';

function syntheticResults(ids: string[]): ApiContentBlock[] {
  return ids.map((id) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: INTERRUPTED_NOTE,
    is_error: true,
  }));
}

export function repairHistory(messages: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  let changed = false;
  /** tool_use ids from the last assistant message still awaiting results */
  let pending: string[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    out.push({ role: 'user', content: syntheticResults(pending) });
    pending = [];
    changed = true;
  };

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      flushPending();
      out.push(msg);
      pending = msg.content
        .filter((b): b is Extract<ApiContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => b.id);
      continue;
    }

    // user message: match its tool_results against the pending batch
    const pendingSet = new Set(pending);
    const kept = msg.content.filter(
      (b) => b.type !== 'tool_result' || pendingSet.has(b.tool_use_id),
    );
    if (kept.length !== msg.content.length) changed = true;

    const consumed = new Set(
      kept.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id),
    );

    if (consumed.size > 0) {
      // This is the result message for the pending batch — complete it in
      // place with synthetic results for any tool_use it failed to answer.
      const missing = pending.filter((id) => !consumed.has(id));
      const untouched = missing.length === 0 && kept.length === msg.content.length;
      if (missing.length > 0) changed = true;
      pending = [];
      out.push(untouched ? msg : { role: 'user', content: [...syntheticResults(missing), ...kept] });
    } else {
      // Plain user turn while results are still owed → insert them first.
      flushPending();
      if (kept.length > 0) {
        out.push(kept.length === msg.content.length ? msg : { role: 'user', content: kept });
      } else {
        changed = true; // emptied message dropped
      }
    }
  }

  flushPending();
  return changed ? out : messages;
}
