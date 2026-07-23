/**
 * Context management (Pi-style, adapted to the browser store):
 *
 *  - `stripStaleSnapshots` — wire-side, per LLM call: every user turn carries
 *    a full `<project_state>` snapshot when sent, but only the LATEST one is
 *    ground truth (the system prompt says so). Stripping the stale ones from
 *    older turns is a large token win at zero information cost. Pure — the
 *    stored history keeps its snapshots.
 *
 *  - `compactHistory` — store-side, before a send when the context is close
 *    to the model's limit: summarize the older turns WITH THE MODEL (through
 *    the same /agent/stream proxy, `tools: []`) and replace them with one
 *    `<context_summary>` user message. Falls back to doing nothing on any
 *    failure — compaction must never break a send (the structural trim in
 *    trimHistory remains the floor).
 */

import { streamText, trimHistory, type AgentSettings } from './AgentRunner';
import type { ApiMessage } from './types';

export const DEFAULT_CONTEXT_LIMIT_TOKENS = 100_000;
/** Compact when the last prompt grew past this fraction of the limit. */
const COMPACT_THRESHOLD = 0.75;
/** Real user turns kept verbatim (with their tool traffic) after compaction. */
const KEEP_RECENT_USER_TURNS = 2;

const SNAPSHOT_RE = /<project_state>[\s\S]*?<\/project_state>\s*/g;

function isRealUserTurn(m: ApiMessage): boolean {
  return m.role === 'user' && m.content[0]?.type === 'text';
}

/** Crude but provider-agnostic size estimate when the upstream reports no usage. */
export function estimateTokens(messages: ApiMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m.content).length;
  return Math.round(chars / 4);
}

/**
 * Strip `<project_state>` blocks from every real user turn except the last
 * one. Returns a new array; untouched messages keep their references.
 */
export function stripStaleSnapshots(messages: ApiMessage[]): ApiMessage[] {
  let lastRealUserTurn = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserTurn(messages[i])) {
      lastRealUserTurn = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (!isRealUserTurn(m) || i === lastRealUserTurn) return m;
    const first = m.content[0];
    if (first.type !== 'text' || !SNAPSHOT_RE.test(first.text)) return m;
    SNAPSHOT_RE.lastIndex = 0;
    const stripped = first.text.replace(
      SNAPSHOT_RE,
      '(project snapshot from this turn omitted — see the latest <project_state>)\n',
    );
    return { ...m, content: [{ ...first, text: stripped }, ...m.content.slice(1)] };
  });
}

/** Default wire-side transform: stale-snapshot strip + structural trim floor. */
export function defaultTransformContext(messages: ApiMessage[]): ApiMessage[] {
  return trimHistory(stripStaleSnapshots(messages));
}

export function shouldCompact(
  messages: ApiMessage[],
  lastPromptTokens: number,
  limitTokens: number | undefined,
): boolean {
  const limit = limitTokens || DEFAULT_CONTEXT_LIMIT_TOKENS;
  const size = lastPromptTokens > 0 ? lastPromptTokens : estimateTokens(messages);
  return size > limit * COMPACT_THRESHOLD;
}

const SUMMARY_SYSTEM =
  'You summarize an AI hardware-assistant conversation so it can continue with less context. ' +
  'Produce a compact plain-text summary that preserves, in order: (1) each user request, ' +
  '(2) what was built/changed — component ids, pin assignments, wiring decisions, file names, ' +
  '(3) problems hit and how they were resolved, (4) anything explicitly left unfinished. ' +
  'No preamble, no markdown headings — dense factual lines. Answer in the language the user used.';

/** Find the cut index: everything before it gets summarized. */
function findCut(messages: ApiMessage[]): number {
  const userTurns: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserTurn(messages[i])) userTurns.push(i);
  }
  if (userTurns.length <= KEEP_RECENT_USER_TURNS) return 0;
  return userTurns[userTurns.length - KEEP_RECENT_USER_TURNS];
}

/**
 * Summarize the turns before the cut into a `<context_summary>` message.
 * Returns a NEW history array, or the input unchanged when there is nothing
 * to compact or the summarization call fails.
 */
export async function compactHistory(
  messages: ApiMessage[],
  settings: AgentSettings,
): Promise<ApiMessage[]> {
  const cut = findCut(messages);
  if (cut <= 0) return messages;

  try {
    // Old snapshots carry no information the summary needs — strip before
    // paying for them one last time.
    const toSummarize = stripStaleSnapshots(messages.slice(0, cut));
    const prompt: ApiMessage[] = [
      ...toSummarize,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[summarize now] Write the context summary described in your instructions.',
          },
        ],
      },
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let summary: string;
    try {
      summary = await streamText(prompt, settings, controller.signal, SUMMARY_SYSTEM);
    } finally {
      clearTimeout(timeout);
    }
    if (!summary) return messages;

    const summaryMsg: ApiMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `<context_summary>\nEarlier turns were compacted to this summary:\n${summary}\n` +
            `The CURRENT project state is in the latest <project_state> block — trust it, not memory.\n</context_summary>`,
        },
      ],
    };
    return [summaryMsg, ...messages.slice(cut)];
  } catch {
    return messages; // never block a send on compaction
  }
}
