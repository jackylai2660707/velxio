/**
 * Typed event stream for the agent loop (Pi-style).
 *
 * The runner emits one flat discriminated union instead of a bag of
 * callbacks; the UI consumes it through a pure reducer (uiReducer.ts), and
 * new run phases (steering, compaction, tool progress) become new event
 * variants instead of new callback parameters.
 */

export type RunEndReason = 'done' | 'aborted' | 'error' | 'iteration_cap';

export type AgentEvent =
  /** A user-visible run begins (one send / one steering-promoted turn chain) */
  | { type: 'run_start' }
  /** One LLM streaming call is about to start */
  | { type: 'llm_call_start'; iteration: number }
  /** Assistant opened a new text block (UI opens a new text segment) */
  | { type: 'text_block_start' }
  | { type: 'text_delta'; delta: string }
  /** Reasoning-model liveness: `chars` more hidden-reasoning characters */
  | { type: 'thinking_progress'; chars: number }
  /** Upstream-reported token usage for one model call */
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  /** Streaming progress from a long-running tool (compile log tail, …) */
  | { type: 'tool_update'; id: string; detail: string }
  | { type: 'tool_end'; id: string; result: string; isError: boolean; diff?: string }
  /** Context compaction lifecycle — surfaces a "context compacted" divider */
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; ok: boolean }
  /** Approaching the per-turn iteration cap (`remaining` LLM calls left) */
  | { type: 'turn_limit_warning'; remaining: number }
  /** A queued steering message was injected mid-turn (as tool-result text) */
  | { type: 'steering_injected'; text: string }
  /** A queued message was promoted to a full follow-up user turn at turn end */
  | { type: 'follow_up_turn'; text: string }
  | { type: 'run_end'; reason: RunEndReason; error?: string };

export type AgentEventHandler = (ev: AgentEvent) => void;
