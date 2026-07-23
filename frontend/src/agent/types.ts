/**
 * Types shared by the AI assistant loop, tools, and chat UI.
 *
 * `ApiContentBlock` / `ApiMessage` mirror the Anthropic Messages API wire
 * shapes — the runner replays them verbatim on each turn (including thinking
 * blocks and their signatures, which the API requires unchanged).
 */

export interface ApiTextBlock {
  type: 'text';
  text: string;
}

export interface ApiThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ApiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApiToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ApiContentBlock =
  | ApiTextBlock
  | ApiThinkingBlock
  | ApiToolUseBlock
  | ApiToolResultBlock;

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: ApiContentBlock[];
}

/** Anthropic custom-tool definition (JSON Schema input). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Chat UI model ──────────────────────────────────────────────────────────

export interface UiTextSegment {
  kind: 'text';
  text: string;
}

export interface UiToolSegment {
  kind: 'tool';
  name: string;
  /** Human-readable one-liner, e.g. `add_component led-red at (420, 80)` */
  label: string;
  status: 'running' | 'ok' | 'error';
  /** Result / error detail shown when expanded */
  detail?: string;
  /** Line diff for code-writing tools, rendered as a colored diff card */
  diff?: string;
}

export interface UiNoticeSegment {
  kind: 'notice';
  /** Localized at render time by the panel */
  notice: 'compaction';
}

export type UiSegment = UiTextSegment | UiToolSegment | UiNoticeSegment;

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  segments: UiSegment[];
  /** Set on the last assistant message when the turn ended abnormally */
  error?: string;
  /** Characters of hidden model reasoning streamed so far (reasoning models
   *  via the openai provider) — drives the "deep thinking…" liveness hint. */
  thinkingChars?: number;
  /** Token usage accumulated across this turn's model calls */
  usage?: { input: number; output: number };
}
