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

/** Keep full definitions for local validation, but compact explanatory prose
 * sent to the model on every loop. Names, required fields and schema types are
 * unchanged; only repetitive descriptions are shortened. */
const MODEL_TOOL_DESCRIPTION_LIMIT = 260;
const MODEL_PROPERTY_DESCRIPTION_LIMIT = 110;
function compactModelTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const properties = Object.fromEntries(
      Object.entries(tool.input_schema.properties ?? {}).map(([key, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
        const property = value as Record<string, unknown>;
        const description = typeof property.description === 'string'
          ? property.description.slice(0, MODEL_PROPERTY_DESCRIPTION_LIMIT)
          : property.description;
        return [key, { ...property, ...(description ? { description } : {}) }];
      }),
    );
    return {
      ...tool,
      description: tool.description.length > MODEL_TOOL_DESCRIPTION_LIMIT
        ? `${tool.description.slice(0, MODEL_TOOL_DESCRIPTION_LIMIT)}…`
        : tool.description,
      input_schema: { ...tool.input_schema, properties },
    };
  });
}
const MODEL_TOOL_DEFINITIONS = compactModelTools(TOOL_DEFINITIONS);

// Keep a generous budget for multi-part ESP32 tasks, while preventing a
// finished project from entering a repeated edit/simulate loop. The model is
// instructed to stop after one evidence pass; this cap is the final safety net.
const MAX_ITERATIONS = 24;
const MAX_STREAM_RETRIES = 2;

function retryableStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Retry transport/provider overloads only. Auth, validation, and tool
  // errors are deterministic and retrying them burns quota without helping.
  return /(?:HTTP\s*(?:408|425|429|5\d\d)|fetch failed|network|timed? ?out|temporar|overload|rate limit|stream error|stream ended|terminal event|incomplete stream)/i.test(message);
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal): Promise<void> {
  const delay = 400 * 2 ** attempt;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { const error = new Error('Aborted'); error.name = 'AbortError'; return reject(error); }
    const timer = setTimeout(resolve, delay);
    signal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
  });
}

async function streamWithRetry(
  messages: ApiMessage[], settings: AgentSettings, signal: AbortSignal,
  onEvent: AgentEventHandler, system = SYSTEM_PROMPT,
  tools: ToolDefinition[] = MODEL_TOOL_DEFINITIONS,
): Promise<StreamedMessage> {
  for (let attempt = 0; ; attempt++) {
    // Text is transactional across retries. A provider can close a stream
    // after sending half a sentence; forwarding that partial text immediately
    // would make the UI show it twice when the retry replays the sentence.
    // Keep text events until the attempt has a valid terminal frame. Thinking
    // liveness and usage events remain immediate because they are not part of
    // the assistant history and cannot be replayed as visible text.
    const bufferedText: Parameters<AgentEventHandler>[0][] = [];
    const attemptHandler: AgentEventHandler = (event) => {
      if (event.type === 'text_block_start' || event.type === 'text_delta') {
        bufferedText.push(event);
      } else {
        onEvent(event);
      }
    };
    try {
      const message = await streamOneMessage(messages, settings, signal, attemptHandler, system, tools);
      for (const event of bufferedText) onEvent(event);
      return message;
    } catch (error) {
      if (attempt >= MAX_STREAM_RETRIES || signal.aborted || !retryableStreamError(error)) {
        // Preserve the useful partial response when no retry remains. It is
        // intentionally not added to API history (the call did not complete),
        // but users should still see why the turn stopped.
        for (const event of bufferedText) onEvent(event);
        throw error;
      }
      await waitBeforeRetry(attempt, signal);
    }
  }
}

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

/** Minimal JSON-schema validator for model-produced tool arguments.
 *
 * The provider validates the schema on the way in only inconsistently (many
 * OpenAI-compatible relays accept arbitrary JSON). Validate again immediately
 * before a local mutation so missing/incorrect arguments become an explicit
 * tool error instead of being coerced by `executeTool` into a destructive
 * operation. This intentionally supports the small schema subset used by
 * TOOL_DEFINITIONS and fails closed for malformed top-level values.
 */
type JsonSchema = {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaTypeMatches(value: unknown, type: string | undefined): boolean {
  if (!type) return true;
  switch (type) {
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // Unknown schema keywords/types are not a reason to execute untrusted
      // input. The definition itself is local and covered by tests, so this
      // branch mainly protects against a future malformed definition.
      return false;
  }
}

function validateSchema(value: unknown, schema: JsonSchema, path: string): string | null {
  if (!schemaTypeMatches(value, schema.type)) {
    return `${path} must be ${schema.type ?? 'a valid JSON value'}`;
  }
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    return `${path} must be one of: ${schema.enum.map(String).join(', ')}`;
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    if (!isJsonObject(value)) return `${path} must be an object`;
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required) || value[required] === undefined) {
        return `${path}.${required} is required`;
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
        const error = validateSchema(value[key], child, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const error = validateSchema(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

function validateToolInput(name: string, input: unknown): string | null {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) return `Unknown tool "${name}".`;
  if (!isJsonObject(input)) return `Invalid input for ${name}: expected a JSON object.`;
  const schema = definition.input_schema as JsonSchema;
  return validateSchema(input, schema, 'input');
}

/** Parse one backend SSE stream into a complete assistant message. */
async function streamOneMessage(
  messages: ApiMessage[],
  settings: AgentSettings,
  signal: AbortSignal,
  onEvent: AgentEventHandler,
  system: string = SYSTEM_PROMPT,
  tools: ToolDefinition[] = MODEL_TOOL_DEFINITIONS,
): Promise<StreamedMessage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;
  // Cloud session token: when the server's API key serves the request, the
  // backend meters usage against this user's weekly token quota (and rejects
  // anonymous calls), so the Bearer header must ride along.
  try {
    const cloudToken = localStorage.getItem('velxio-cloud-token');
    if (cloudToken) headers['Authorization'] = `Bearer ${cloudToken}`;
  } catch {
    /* private mode */
  }

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
  const partialJsonErrors: Record<number, string> = {};
  const initialInputErrors: Record<number, string> = {};
  const openBlocks = new Set<number>();
  let stopReason: string | null = null;
  let sawTerminalDelta = false;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const eventIndex = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('Malformed stream event: content block index is invalid.');
    }
    return value;
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const handleEvent = (ev: Record<string, unknown>) => {
    switch (ev.type) {
      case 'content_block_start': {
        const idx = eventIndex(ev.index);
        if (openBlocks.has(idx)) {
          throw new Error(`Malformed stream event: content block ${idx} started twice.`);
        }
        openBlocks.add(idx);
        const block = isRecord(ev.content_block) ? ev.content_block : {};
        if (block.type === 'text') {
          content[idx] = { type: 'text', text: '' };
          onEvent({ type: 'text_block_start' });
        } else if (block.type === 'thinking') {
          content[idx] = { type: 'thinking', thinking: '' };
        } else if (block.type === 'tool_use') {
          const initialInput = isRecord(block.input) ? block.input : {};
          if (block.input !== undefined && !isRecord(block.input)) {
            initialInputErrors[idx] = 'Malformed tool input (expected a JSON object).';
          }
          const rawId = block.id;
          const rawName = block.name;
          content[idx] = {
            type: 'tool_use',
            // The backend normally supplies both. Keep the block pairable if
            // an OpenAI relay omits an id, while schema validation below keeps
            // an omitted/invalid name from executing anything.
            id: typeof rawId === 'string' && rawId.trim() ? rawId : `malformed_tool_${idx}`,
            name: typeof rawName === 'string' ? rawName : '',
            input: initialInput,
          };
          partialJson[idx] = '';
        }
        break;
      }
      case 'content_block_delta': {
        const idx = eventIndex(ev.index);
        const delta = isRecord(ev.delta) ? ev.delta : {};
        const block = content[idx];
        if (!block || !openBlocks.has(idx)) {
          throw new Error(`Malformed stream event: delta for unopened content block ${idx}.`);
        }
        if (delta.type === 'text_delta' && block.type === 'text') {
          if (typeof delta.text !== 'string') {
            throw new Error(`Malformed stream event: text delta for block ${idx} is not a string.`);
          }
          block.text += delta.text;
          onEvent({ type: 'text_delta', delta: delta.text });
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          if (typeof delta.thinking !== 'string') {
            throw new Error(`Malformed stream event: thinking delta for block ${idx} is not a string.`);
          }
          block.thinking += delta.thinking;
        } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
          if (typeof delta.signature !== 'string') {
            throw new Error(`Malformed stream event: signature delta for block ${idx} is not a string.`);
          }
          block.signature = (block.signature ?? '') + delta.signature;
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          if (typeof delta.partial_json !== 'string') {
            partialJsonErrors[idx] = 'Malformed tool JSON delta (expected a string).';
          } else {
            partialJson[idx] += delta.partial_json;
          }
        }
        break;
      }
      case 'content_block_stop': {
        const idx = eventIndex(ev.index);
        if (!openBlocks.has(idx)) {
          throw new Error(`Malformed stream event: content block ${idx} stopped before it started.`);
        }
        openBlocks.delete(idx);
        const block = content[idx];
        if (block?.type === 'tool_use' && partialJson[idx] !== undefined) {
          if (partialJsonErrors[idx]) {
            block.input = { __parse_error: partialJsonErrors[idx] };
          } else if (partialJson[idx]) {
            try {
              block.input = JSON.parse(partialJson[idx]);
            } catch {
              block.input = { __parse_error: 'Malformed or truncated tool JSON' };
            }
          } else if (initialInputErrors[idx]) {
            block.input = { __parse_error: initialInputErrors[idx] };
          }
          delete partialJson[idx];
          delete partialJsonErrors[idx];
          delete initialInputErrors[idx];
        }
        break;
      }
      case 'message_delta': {
        const delta = isRecord(ev.delta) ? ev.delta : undefined;
        if (typeof delta?.stop_reason === 'string' && delta.stop_reason.length > 0) {
          stopReason = delta.stop_reason;
          // message_delta carries the semantic terminal reason in the
          // backend protocol. message_stop/velxio_done are advisory framing
          // events; requiring this reason catches silent EOFs while retaining
          // compatibility with minimal OpenAI relays used by compaction.
          sawTerminalDelta = true;
        }
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

  const consumeFrames = (final = false) => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      dispatchFrame(frame);
    }
    // A few proxies close immediately after the final `data:` line without
    // the usual blank separator. Parse that one trailing frame on EOF.
    if (final && buffer.trim()) {
      const frame = buffer;
      buffer = '';
      dispatchFrame(frame);
    }
  };

  const dispatchFrame = (frame: string) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trimStart();
      if (!raw) continue;
      let ev: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) continue;
        ev = parsed;
      } catch {
        // A malformed intermediary line should not turn into an executable
        // tool call. Keep waiting for a valid frame; terminal validation below
        // rejects a stream that never supplies one.
        continue;
      }
      handleEvent(ev);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; support LF and CRLF.
    consumeFrames();
  }
  buffer += decoder.decode();
  consumeFrames(true);

  if (openBlocks.size > 0) {
    throw new Error('Stream ended before every content block was closed.');
  }
  if (!sawTerminalDelta || !stopReason) {
    throw new Error('Stream ended before terminal event (missing stop reason).');
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
  const msg = await streamWithRetry(messages, settings, signal, () => {}, system, []);
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
const MAX_TOTAL_CALLS = 64;

const CAP_WARNING_NOTE =
  '[system note] You are approaching the per-turn step limit. Wrap up: finish the most ' +
  'important remaining action, then summarize what is done and what remains. Stop repeating ' +
  'simulation or edits when the checklist already has evidence.';

/** Project-changing tools that must not run after a successful observation.
 * A model sometimes sees a valid blink trace, then starts a fresh rebuild in
 * the same turn. The lock is scoped to one runTurn call, so a later user turn
 * can still intentionally edit the project. */
const POST_VERIFICATION_BLOCKED_TOOLS = new Set([
  'add_board', 'remove_board', 'set_board_language', 'install_library',
  'add_component', 'update_component', 'remove_component', 'add_wire',
  'remove_wire', 'seat_component', 'write_file', 'edit_file',
  'run_simulation', 'observe_simulation',
]);

// A fresh compile or project mutation invalidates an earlier running binary.
// Track this per turn so run_simulation remains idempotent on retries, while
// still restarting once after the student/agent changes code or wiring.
const RUN_INVALIDATING_TOOLS = new Set([
  'add_board', 'remove_board', 'set_board_language', 'install_library',
  'add_component', 'update_component', 'remove_component', 'add_wire',
  'remove_wire', 'seat_component', 'write_file', 'edit_file', 'compile',
]);

function observationProvesRunning(result: string): boolean {
  // A running board is already authoritative for the one-pass guard. Some
  // valid projects expose no scalar DOM output (breadboard-only wiring,
  // custom chips, or a component still mounting), and requiring a
  // `COMPONENTS: -` line let the model re-run/rebuild those projects forever.
  // If observation reports burnt parts, keep the lock open so the model can
  // make one focused repair; otherwise a second run/observe is never useful in
  // the same turn.
  return /Simulation running on:/i.test(result) && !/BURNT COMPONENTS/i.test(result);
}

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
  const iterationLimit = MAX_ITERATIONS;
  const totalCallLimit = MAX_TOTAL_CALLS;
  let verificationPassed = false;
  const turnMemory = {
    removedWireFingerprints: new Set<string>(),
    createdWireIds: new Set<string>(),
    mutationEpoch: 0,
    runEpoch: -1,
  };
  // A common failure mode is the model issuing the exact same inspection or
  // simulation call forever after the project is already correct. Keep a
  // small per-turn fingerprint guard; two executions are enough for a valid
  // retry, a third identical request becomes a non-mutating tool error that
  // tells the model to stop and summarize.
  const repeatedToolCalls = new Map<string, number>();

  for (;;) {
    if (iteration >= iterationLimit || totalCalls >= totalCallLimit) {
      // Cap reached — return what we have; the store surfaces a notice.
      return end({ appended, aborted: false, capped: true });
    }
    onEvent({ type: 'llm_call_start', iteration });
    iteration++;
    totalCalls++;

    let msg: StreamedMessage;
    try {
      const wire = options.transformContext ? options.transformContext(working) : working;
      msg = await streamWithRetry(wire, settings, signal, onEvent);
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
    const truncated = msg.stopReason === 'max_tokens' || msg.stopReason === 'length';
    if (truncated) {
      if (toolUses.length === 0) return end({ appended, aborted: false, capped: true });
      const failed: ApiContentBlock[] = toolUses.map((tu) => ({
        type: 'tool_result', tool_use_id: tu.id,
        content: 'Tool call was truncated by the model output limit and was not executed. Re-issue it with complete arguments.',
        is_error: true,
      }));
      const failedMsg: ApiMessage = { role: 'user', content: failed };
      appended.push(failedMsg); working.push(failedMsg);
      continue;
    }
    if (toolUses.length === 0) {
      if (msg.stopReason === 'tool_use') {
        // Keep the history terminal and tell the caller why no tool work was
        // performed. A malformed provider response must not be treated as a
        // successful turn with an impossible tool-use stop reason.
        return end({
          appended,
          aborted: false,
          error: 'Model requested tool use but returned no tool calls.',
        });
      }
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
      if (isJsonObject(tu.input) && typeof tu.input.__parse_error === 'string') {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: tu.input.__parse_error, is_error: true });
        continue;
      }
      const inputError = validateToolInput(tu.name, tu.input);
      if (inputError) {
        // Pair every tool_use, but never invoke a local tool with malformed
        // arguments. The model gets a precise correction and can re-issue it.
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Invalid tool input: ${inputError}`,
          is_error: true,
        });
        continue;
      }
      const fingerprint = `${tu.name}:${JSON.stringify(tu.input)}`;
      const repeatCount = (repeatedToolCalls.get(fingerprint) ?? 0) + 1;
      repeatedToolCalls.set(fingerprint, repeatCount);
      onEvent({ type: 'tool_start', id: tu.id, name: tu.name, input: tu.input });
      if (verificationPassed && POST_VERIFICATION_BLOCKED_TOOLS.has(tu.name)) {
        const message = `Verification already passed with live simulation evidence. ` +
          `Do not ${tu.name} or rebuild the project in this turn; summarize the result. ` +
          'Wait for a new user request before making changes.';
        onEvent({ type: 'tool_end', id: tu.id, result: message, isError: true });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: message, is_error: true });
        continue;
      }
      if (repeatCount > 2) {
        const message = `Repeated identical ${tu.name} call detected with unchanged input. ` +
          'Do not repeat verification; use the existing result and summarize the completed work.';
        onEvent({ type: 'tool_end', id: tu.id, result: message, isError: true });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: message, is_error: true });
        continue;
      }
      if (RUN_INVALIDATING_TOOLS.has(tu.name)) turnMemory.mutationEpoch++;
      const { result, isError, diff } = await executeTool(tu.name, tu.input, {
        toolCallId: tu.id,
        signal,
        turnMemory,
        onUpdate: (detail) => onEvent({ type: 'tool_update', id: tu.id, detail }),
      });
      onEvent({ type: 'tool_end', id: tu.id, result, isError, diff });
      if (tu.name === 'observe_simulation' && !isError && observationProvesRunning(result)) {
        verificationPassed = true;
      }
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
    if (iteration === iterationLimit - CAP_WARNING_MARGIN) {
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
export function trimHistory(history: ApiMessage[], maxMessages = 24): ApiMessage[] {
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
