/**
 * Chat state for the AI assistant panel.
 *
 * Two parallel histories:
 *  - `apiMessages` — block-shaped messages replayed to the backend every turn
 *    (tool_use / tool_result blocks; the backend translates them to the
 *    OpenAI chat-completions wire format).
 *  - `messages`    — UI rendering (text segments + tool chips + diffs).
 *
 * Both are persisted to localStorage (debounced) so a page refresh keeps the
 * conversation. Endpoint settings (OpenAI-compatible base URL, key, model,
 * effort) also live in localStorage and are sent with every request; the
 * backend fills anything left blank from its environment defaults.
 *
 * Every user turn captures a full project checkpoint first — the message
 * bubble gets a "restore" button that rolls the whole project back.
 */

import { create } from 'zustand';
import { getApiBase } from '../lib/apiBase';
import { runTurn, trimHistory, type AgentSettings } from '../agent/AgentRunner';
import { SteeringQueue } from '../agent/AgentSession';
import {
  compactHistory,
  defaultTransformContext,
  shouldCompact,
} from '../agent/compaction';
import { repairHistory } from '../agent/historyRepair';
import { useVersionStore } from '../versioning/useVersionStore';
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { buildExampleHint } from '../agent/exampleHints';
import {
  captureCheckpoint,
  restoreCheckpoint,
  type ProjectCheckpoint,
} from '../agent/checkpoint';
import { applyAgentEvent } from '../agent/uiReducer';
import type { AgentEvent } from '../agent/events';
import type { ApiMessage, UiMessage } from '../agent/types';

const SETTINGS_STORAGE = 'velxio-agent-settings';
const LEGACY_KEY_STORAGE = 'velxio-agent-api-key';
const PANEL_WIDTH_STORAGE = 'velxio-agent-panel-width';
const CHAT_STORAGE = 'velxio-agent-chat';
const SCOPED_CHAT_STORAGE = 'velxio-agent-chat-scoped-v1';
const MAX_CHECKPOINTS = 10;
const MAX_PERSISTED_UI_MESSAGES = 80;
/** Stored API history cap. Wire-size is controlled per LLM call by
 *  defaultTransformContext (snapshot stripping + structural trim), so the
 *  store can afford to keep much more raw history than fits one request. */
const MAX_STORED_API_MESSAGES = 200;

/**
 * Wire-side context budget.  The persistent history remains intact for the
 * student's chat view, but each model call only needs a small recent window:
 * the latest project snapshot is ground truth, while old tool traffic is
 * useful only as a short audit trail.  Keeping this budget here (instead of
 * shrinking the stored history) also makes retries and explicit history
 * loading lossless.
 */
const MAX_WIRE_HISTORY_MESSAGES = 12;
const MAX_WIRE_CURRENT_TURN_MESSAGES = 16;
const MAX_WIRE_TEXT_CHARS = 2_400;
const MAX_WIRE_SAFETY_TEXT_CHARS = 5_200;
const MAX_WIRE_RECENT_TEXT_CHARS = 6_000;
const SAFETY_FACT_RE = /hardware safety|circuit errors?|overcurrent|short(?:ed| circuit)?|voltage|gpio|pin(?:s| assignment)?/i;
const PROJECT_SNAPSHOT_RE = /(?:^|\n)BOARDS:\s*[\s\S]*\nCOMPONENTS:\s*[\s\S]*\nWIRES:\s*[\s\S]*\nFILES:/;

let uiIdCounter = 0;
const nextUiId = () => `agent-msg-${++uiIdCounter}`;

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentSettings & { provider?: string };
      delete parsed.provider; // pre-OpenAI-only versions stored this
      return parsed;
    }
    // Migrate the pre-settings key slot
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
    if (legacy) return { apiKey: legacy };
  } catch {
    /* private mode / SSR */
  }
  return {};
}

function persistSettings(s: AgentSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(s));
    localStorage.removeItem(LEGACY_KEY_STORAGE);
  } catch {
    /* private mode — settings live for the session only */
  }
}

/**
 * Auth headers shared by the settings-panel probes.  Unlike the streaming
 * request (which builds its headers in AgentRunner), `/agent/models` and
 * `/agent/test` are authenticated endpoints even when the user relies on the
 * server-side model key.  Omitting the cloud session token here made those
 * two buttons return 401 while normal chat still worked.
 */
function agentProbeHeaders(settings: AgentSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;
  try {
    const token = localStorage.getItem('velxio-cloud-token');
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* private mode / SSR */
  }
  return headers;
}

interface PersistedChat {
  /** Workspace identity. Chats without this field are legacy global history
   * and are intentionally not loaded into a new workspace. */
  scope?: string;
  messages: UiMessage[];
  apiMessages: ApiMessage[];
  uiIdCounter: number;
}

type ScopedChatMap = Record<string, PersistedChat>;

function readScopedChats(): ScopedChatMap {
  try {
    const raw = localStorage.getItem(SCOPED_CHAT_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScopedChatMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeScopedChats(chats: ScopedChatMap): void {
  try {
    // Keep browser storage bounded. Old sessions remain available in the
    // signed-in cloud history; this map is only an offline continuity cache.
    const entries = Object.entries(chats).slice(-24);
    localStorage.setItem(SCOPED_CHAT_STORAGE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* quota / private mode */
  }
}

function persistScopedChat(scope: string, payload: PersistedChat): void {
  if (!scope) return;
  const chats = readScopedChats();
  chats[scope] = { ...payload, scope };
  writeScopedChats(chats);
}

function loadScopedChat(scope: string): PersistedChat {
  const payload = readScopedChats()[scope];
  if (!payload || !Array.isArray(payload.messages) || !Array.isArray(payload.apiMessages)) {
    return { scope, messages: [], apiMessages: [], uiIdCounter: 0 };
  }
  return {
    scope,
    messages: payload.messages ?? [],
    apiMessages: repairHistory(payload.apiMessages ?? []),
    uiIdCounter: payload.uiIdCounter ?? 0,
  };
}

function loadChat(): PersistedChat {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedChat;
      // A tool left 'running' by a refresh will never finish — mark it.
      for (const m of parsed.messages) {
        for (const seg of m.segments) {
          if (seg.kind === 'tool' && seg.status === 'running') {
            seg.status = 'error';
            seg.detail = '(interrupted by page reload)';
          }
        }
      }
      // Before workspace scoping existed, this key represented an arbitrary
      // mixture of projects. Keep it in storage for manual/cloud migration,
      // but never inject it into the first workspace after the upgrade.
      if (!parsed.scope) return { scope: 'legacy', messages: [], apiMessages: [], uiIdCounter: 0 };
      return {
        scope: parsed.scope,
        messages: parsed.messages ?? [],
        // A reload mid-run persists dangling tool_use blocks — repair them
        // or every request after the reload gets a 400 from the upstream.
        apiMessages: repairHistory(parsed.apiMessages ?? []),
        uiIdCounter: parsed.uiIdCounter ?? 0,
      };
    }
  } catch {
    /* corrupted / private mode */
  }
  return { messages: [], apiMessages: [], uiIdCounter: 0 };
}

function isRealUserTurn(message: ApiMessage): boolean {
  return message.role === 'user' && message.content[0]?.type === 'text';
}

function isProjectSnapshotResult(block: ApiMessage['content'][number]): boolean {
  return block.type === 'tool_result' && PROJECT_SNAPSHOT_RE.test(block.content);
}

/** Keep the beginning (scope/diagnostic heading) and end (latest detail) of
 * an old text block.  Never apply this to the current project snapshot: the
 * latest user turn is deliberately kept byte-for-byte intact. */
function shortenContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(1_000, Math.floor(maxChars * 0.62));
  const tail = Math.max(300, maxChars - head);
  return `${text.slice(0, head)}\n… [older context trimmed] …\n${text.slice(-tail)}`;
}

/** Trim only historical prose/results.  Thinking signatures and tool-use
 * inputs stay untouched because providers require those blocks to replay
 * exactly; tool-result pairing is therefore always wire-valid. */
function shortenHistoricalMessage(message: ApiMessage, recent: boolean): ApiMessage {
  const blocks = message.content.map((block) => {
    if (block.type === 'text') {
      const safety = SAFETY_FACT_RE.test(block.text);
      const limit = safety
        ? MAX_WIRE_SAFETY_TEXT_CHARS
        : recent
          ? MAX_WIRE_RECENT_TEXT_CHARS
          : MAX_WIRE_TEXT_CHARS;
      return block.text.length > limit ? { ...block, text: shortenContextText(block.text, limit) } : block;
    }
    if (block.type === 'tool_result') {
      const safety = SAFETY_FACT_RE.test(block.content);
      const limit = safety
        ? MAX_WIRE_SAFETY_TEXT_CHARS
        : recent
          ? MAX_WIRE_RECENT_TEXT_CHARS
          : MAX_WIRE_TEXT_CHARS;
      return block.content.length > limit ? { ...block, content: shortenContextText(block.content, limit) } : block;
    }
    return block;
  });
  return blocks.some((block, index) => block !== message.content[index])
    ? { ...message, content: blocks }
    : message;
}

/**
 * Build a bounded, wire-only history.  `defaultTransformContext` first drops
 * stale project snapshots and trims at complete user-turn boundaries.  This
 * second pass handles the one case that boundary trimming cannot solve: a
 * single long tool run has one real user turn followed by dozens of
 * assistant/tool-result pairs.  We retain the latest pairs and the current
 * snapshot, so the model can continue safely without paying for the whole
 * transcript on every iteration.
 */
function buildWireContext(messages: ApiMessage[]): ApiMessage[] {
  const transformed = defaultTransformContext(messages);
  let latestUserIndex = -1;
  for (let i = transformed.length - 1; i >= 0; i--) {
    if (isRealUserTurn(transformed[i])) {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return transformed;

  // Keep a small, complete history before the current turn.  trimHistory
  // inserts a structural summary whenever it drops anything, preserving old
  // user intent without replaying stale project snapshots.
  const prefix = trimHistory(transformed.slice(0, latestUserIndex), MAX_WIRE_HISTORY_MESSAGES);
  const latestUser = transformed[latestUserIndex];
  const currentTail = transformed.slice(latestUserIndex + 1);
  let keptTail = currentTail;
  if (currentTail.length > MAX_WIRE_CURRENT_TURN_MESSAGES) {
    const floor = currentTail.length - MAX_WIRE_CURRENT_TURN_MESSAGES;
    // Start on an assistant message so no tool_use/tool_result pair is split.
    let boundary = currentTail.findIndex((message, index) => index >= floor && message.role === 'assistant');
    if (boundary < 0) {
      boundary = currentTail
        .map((message, index) => (message.role === 'assistant' && index < floor ? index : -1))
        .reduce((last, index) => Math.max(last, index), -1);
    }
    keptTail = currentTail.slice(boundary >= 0 ? boundary : 0);
  }

  const history = [...prefix, latestUser, ...keptTail];
  // `get_project` can return the same large snapshot that is injected into a
  // user turn. Keep only its newest result; replaying older snapshots wastes
  // tokens and can make the model trust stale wiring after a mutation. The
  // newest result stays complete because it may be the only post-mutation
  // state available during a long tool run.
  let latestProjectResult = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].content.some(isProjectSnapshotResult)) {
      latestProjectResult = i;
      break;
    }
  }
  // Prefix prose/results can contain large compile logs or example payloads;
  // retain concise diagnostics while leaving the current turn untouched.
  const prefixLength = prefix.length;
  return history.map((message, index) => {
    // The latest user message contains the full live <project_state>; never
    // shorten it.  Current-turn tool results are still capped, with a larger
    // limit than old history so fresh diagnostics remain actionable.
    if (index === prefixLength) return message;
    if (latestProjectResult >= 0 && index < latestProjectResult && message.content.some(isProjectSnapshotResult)) {
      const content = message.content.map((block) =>
        isProjectSnapshotResult(block)
          ? {
              ...block,
              content: '(older get_project snapshot omitted — see the latest project state result)',
            }
          : block,
      );
      return { ...message, content };
    }
    return shortenHistoricalMessage(message, index > prefixLength);
  });
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistChat(get: () => AgentState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const { messages, apiMessages } = get();
      const payload: PersistedChat = {
        scope: get().workspaceScope,
        messages: messages.slice(-MAX_PERSISTED_UI_MESSAGES),
        apiMessages: trimHistory(apiMessages, MAX_STORED_API_MESSAGES),
        uiIdCounter,
      };
      localStorage.setItem(CHAT_STORAGE, JSON.stringify(payload));
      persistScopedChat(get().workspaceScope, payload);
    } catch {
      /* quota / private mode — persistence is best-effort */
    }
  }, 800);
}

export interface AgentServerConfig {
  base_url: string;
  model: string;
  effort: string;
  server_has_key: boolean;
  /** Admin settings: may users pick their own model/effort? */
  allow_custom_model?: boolean;
  /** Admin settings: may users bring their own base URL / API key? */
  allow_own_key?: boolean;
}

interface TurnCheckpoint {
  msgId: string;
  label: string;
  state: ProjectCheckpoint;
}

/** Best-effort project checkpoint for a user turn — never blocks a send.
 *  The same snapshot also lands in the durable version history (fire and
 *  forget), so every AI turn is a restorable version even after a reload. */
function tryCaptureCheckpoint(msgId: string, label: string): TurnCheckpoint | null {
  try {
    const state = captureCheckpoint();
    void useVersionStore.getState().saveVersionFromCheckpoint(state, label.slice(0, 40), 'ai');
    return { msgId, label: label.slice(0, 40), state };
  } catch {
    return null;
  }
}

/** Assemble a full API user turn: fresh <project_state> snapshot + optional
 *  example hint + the user's text. Used for the initial send AND for
 *  steering messages promoted to follow-up turns. Follow-ups omit the hint:
 *  it is reference material, not new state, and repeating it burns tokens. */
function buildUserTurnMessage(text: string, includeExampleHint = true): ApiMessage {
  const exampleHint = includeExampleHint ? buildExampleHint(text) : '';
  const scope = useAgentStore.getState().workspaceScope;
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `<workspace_scope>${scope}</workspace_scope>\n` +
          `<project_state>\n${buildProjectSnapshot()}\n</project_state>\n\n` +
          (exampleHint ? `${exampleHint}\n\n` : '') +
          text,
      },
    ],
  };
}

interface AgentState {
  /** Stable identity of the loaded assignment/project/example workspace. */
  workspaceScope: string;
  panelOpen: boolean;
  panelWidth: number;
  busy: boolean;
  settingsOpen: boolean;
  /** Environment defaults reported by the backend (null = not fetched yet) */
  serverConfig: AgentServerConfig | null;
  settings: AgentSettings;
  /** Model ids reported by the upstream /models endpoint (settings datalist) */
  modelList: string[];
  messages: UiMessage[];
  apiMessages: ApiMessage[];
  checkpoints: TurnCheckpoint[];
  abortController: AbortController | null;
  /** Bumped by clearChat so an in-flight run can't resurrect cleared history */
  generation: number;
  /** Text of the last send that failed — enables one-click retry */
  failedText: string | null;
  /** Last run stopped at the iteration cap — the panel offers "continue" */
  cappedRun: boolean;
  /** Steering queue of the active run (null when idle) */
  steeringQueue: SteeringQueue | null;
  /** Mirror of queued (not yet injected) steering texts, for the pending chips */
  pendingSteering: string[];
  /** Session token totals (sum of upstream-reported usage) */
  totalTokens: { input: number; output: number };
  /** Prompt size of the most recent model call — drives compaction */
  lastPromptTokens: number;

  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<AgentSettings>) => void;
  fetchConfig: () => Promise<void>;
  fetchModels: () => Promise<{ ok: boolean; message?: string }>;
  testConnection: () => Promise<{ ok: boolean; message: string; latency_ms?: number }>;
  clearChat: () => void;
  /** Switch conversation namespace when the loaded workspace changes. */
  switchWorkspaceScope: (scope: string) => void;
  stop: () => void;
  send: (text: string) => Promise<void>;
  retry: () => void;
  /** Resume a run that stopped at the iteration cap */
  continueRun: () => void;
  /** Queue a message into the ACTIVE run (falls back to send when idle) */
  steer: (text: string) => void;
  /** Remove a not-yet-injected steering message by index */
  unqueueSteering: (index: number) => void;
  /** Roll the project back to the state captured before the given user turn */
  restoreToTurn: (msgId: string) => Promise<void>;
  hasCheckpoint: (msgId: string) => boolean;
  /** Replace the whole conversation (cloud session load). Aborts any run. */
  hydrateSession: (messages: UiMessage[], apiMessages: ApiMessage[]) => void;
}

/** True when a request would be rejected for lack of any API key. */
export function needsApiKey(state: Pick<AgentState, 'serverConfig' | 'settings'>): boolean {
  if (state.settings.apiKey) return false;
  return state.serverConfig !== null && !state.serverConfig.server_has_key;
}

/** Model shown in the header: user override, else server default. */
export function effectiveModel(state: Pick<AgentState, 'serverConfig' | 'settings'>): string {
  return state.settings.model || state.serverConfig?.model || '';
}

const initialChat = typeof localStorage !== 'undefined' ? loadChat() : { scope: 'legacy', messages: [], apiMessages: [], uiIdCounter: 0 };
// Route/project hydration happens after the app mounts. Do not render a
// persisted conversation before that identity is known: `/editor` can be a
// completely different workspace after a reload. Scoped history is restored
// only by switchWorkspaceScope() once the route establishes the scope.
const initialUiIdCounter = initialChat.uiIdCounter;
uiIdCounter = initialUiIdCounter;

export const useAgentStore = create<AgentState>((set, get) => ({
  // A legacy unscoped chat is intentionally hidden. A scoped chat can survive
  // a page refresh and will be replaced automatically when a different
  // project/example is loaded.
  workspaceScope: 'scratch',
  panelOpen: false,
  panelWidth: (() => {
    try {
      const w = Number(localStorage.getItem(PANEL_WIDTH_STORAGE));
      return w >= 300 && w <= 640 ? w : 400;
    } catch {
      return 400;
    }
  })(),
  busy: false,
  settingsOpen: false,
  serverConfig: null,
  settings: typeof localStorage !== 'undefined' ? loadSettings() : {},
  modelList: [],
  messages: [],
  apiMessages: [],
  checkpoints: [],
  abortController: null,
  generation: 0,
  failedText: null,
  cappedRun: false,
  steeringQueue: null,
  pendingSteering: [],
  totalTokens: { input: 0, output: 0 },
  lastPromptTokens: 0,

  togglePanel: () => {
    const open = !get().panelOpen;
    set({ panelOpen: open });
    if (open && get().serverConfig === null) void get().fetchConfig();
  },

  setPanelWidth: (w: number) => {
    const clamped = Math.min(640, Math.max(300, Math.round(w)));
    set({ panelWidth: clamped });
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE, String(clamped));
    } catch {
      /* ignore */
    }
  },

  setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),

  updateSettings: (patch: Partial<AgentSettings>) => {
    const settings = { ...get().settings, ...patch };
    // Drop empty strings so backend env defaults apply
    (Object.keys(settings) as (keyof AgentSettings)[]).forEach((k) => {
      if (!settings[k]) delete settings[k];
    });
    persistSettings(settings);
    set({ settings });
  },

  fetchConfig: async () => {
    try {
      const resp = await fetch(`${getApiBase()}/agent/config`, { credentials: 'include' });
      const j = (await resp.json()) as AgentServerConfig;
      set({ serverConfig: j });
    } catch {
      set({
        serverConfig: { base_url: '', model: '', effort: '', server_has_key: false },
      });
    }
  },

  fetchModels: async () => {
    const { settings } = get();
    try {
      const resp = await fetch(`${getApiBase()}/agent/models`, {
        method: 'POST',
        headers: agentProbeHeaders(settings),
        credentials: 'include',
        body: JSON.stringify({ base_url: settings.baseUrl || undefined }),
      });
      const j = (await resp.json()) as { ok: boolean; models?: string[]; message?: string };
      if (j.ok && j.models) {
        set({ modelList: j.models });
        return { ok: true };
      }
      return { ok: false, message: j.message ?? 'failed' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  testConnection: async () => {
    const { settings } = get();
    try {
      const resp = await fetch(`${getApiBase()}/agent/test`, {
        method: 'POST',
        headers: agentProbeHeaders(settings),
        credentials: 'include',
        body: JSON.stringify({
          base_url: settings.baseUrl || undefined,
          model: settings.model || undefined,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        return { ok: false, message: (j as { detail?: string }).detail ?? `HTTP ${resp.status}` };
      }
      return (await resp.json()) as { ok: boolean; message: string; latency_ms?: number };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  clearChat: () => {
    get().abortController?.abort();
    set((s) => ({
      messages: [],
      apiMessages: [],
      checkpoints: [],
      busy: false,
      abortController: null,
      failedText: null,
      cappedRun: false,
      steeringQueue: null,
      pendingSteering: [],
      totalTokens: { input: 0, output: 0 },
      generation: s.generation + 1,
    }));
    schedulePersistChat(get);
  },

  switchWorkspaceScope: (scope: string) => {
    const nextScope = scope.trim() || `scratch:${Date.now()}`;
    const current = get();
    if (current.workspaceScope === nextScope) return;
    // Archive current conversation under its old workspace before replacing
    // it. This preserves continuity when a student returns to the same
    // assignment, while preventing any old turns from entering the new one.
    persistScopedChat(current.workspaceScope, {
      scope: current.workspaceScope,
      messages: current.messages.slice(-MAX_PERSISTED_UI_MESSAGES),
      apiMessages: trimHistory(current.apiMessages, MAX_STORED_API_MESSAGES),
      uiIdCounter,
    });
    const next = loadScopedChat(nextScope);
    uiIdCounter = Math.max(uiIdCounter, next.uiIdCounter ?? 0);
    get().abortController?.abort();
    set((s) => ({
      workspaceScope: nextScope,
      messages: next.messages,
      apiMessages: next.apiMessages,
      checkpoints: [],
      busy: false,
      abortController: null,
      failedText: null,
      cappedRun: false,
      steeringQueue: null,
      pendingSteering: [],
      generation: s.generation + 1,
      lastPromptTokens: 0,
      totalTokens: { input: 0, output: 0 },
    }));
    schedulePersistChat(get);
  },

  stop: () => {
    get().abortController?.abort();
  },

  retry: () => {
    const text = get().failedText;
    if (text && !get().busy) {
      set({ failedText: null });
      void get().send(text);
    }
  },

  continueRun: () => {
    if (get().busy || !get().cappedRun) return;
    set({ cappedRun: false });
    void get().send('继续 / continue — pick up exactly where you stopped and finish the remaining steps.');
  },

  steer: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { busy, steeringQueue } = get();
    if (!busy || !steeringQueue) {
      void get().send(trimmed);
      return;
    }
    steeringQueue.push(trimmed);
    set((s) => ({ pendingSteering: [...s.pendingSteering, trimmed] }));
  },

  unqueueSteering: (index: number) => {
    const { steeringQueue } = get();
    steeringQueue?.removeAt(index);
    set((s) => ({ pendingSteering: s.pendingSteering.filter((_, i) => i !== index) }));
  },

  hasCheckpoint: (msgId: string) => get().checkpoints.some((c) => c.msgId === msgId),

  hydrateSession: (messages: UiMessage[], apiMessages: ApiMessage[]) => {
    get().abortController?.abort();
    // Advance the ui-id counter past any loaded ids so new messages never
    // collide with restored ones.
    for (const m of messages) {
      const n = Number(/^agent-msg-(\d+)$/.exec(m.id)?.[1]);
      if (Number.isFinite(n) && n > uiIdCounter) uiIdCounter = n;
    }
    set((s) => ({
      // A cloud chat loaded explicitly by the user belongs to the currently
      // selected workspace. Automatic workspace switches never hydrate old
      // cloud sessions, so this remains an intentional action.
      messages,
      apiMessages: repairHistory(apiMessages),
      checkpoints: [], // they referenced the previous conversation's turns
      busy: false,
      abortController: null,
      failedText: null,
      cappedRun: false,
      steeringQueue: null,
      pendingSteering: [],
      generation: s.generation + 1,
    }));
    schedulePersistChat(get);
  },

  // Confirmation lives in the panel (it owns the localized dialog); this
  // action just performs the rollback.
  restoreToTurn: async (msgId: string) => {
    const state = get();
    if (state.busy) return;
    const cp = state.checkpoints.find((c) => c.msgId === msgId);
    if (!cp) return;
    await restoreCheckpoint(cp.state);
  },

  send: async (text: string) => {
    const state = get();
    if (state.busy || !text.trim()) return;

    // Defensive: an earlier abort/crash may have left the history with
    // unpaired tool blocks. Repair before building the request.
    const repairedBase = repairHistory(state.apiMessages);
    if (repairedBase !== state.apiMessages) set({ apiMessages: repairedBase });

    const abortController = new AbortController();
    const generation = state.generation;
    const steering = new SteeringQueue();
    if (state.cappedRun) set({ cappedRun: false });

    // Capture the whole project BEFORE the AI touches anything, so this turn
    // can be rolled back from the message bubble.
    const userUi: UiMessage = { id: nextUiId(), role: 'user', segments: [{ kind: 'text', text }] };
    const checkpoint = tryCaptureCheckpoint(userUi.id, text);

    const assistantUi: UiMessage = { id: nextUiId(), role: 'assistant', segments: [] };
    // Steering promotes new user+assistant bubble pairs mid-run; events always
    // target the newest assistant bubble of THIS run.
    const assistantRef = { id: assistantUi.id };
    const runAssistantIds = new Set([assistantUi.id]);

    set((s) => ({
      busy: true,
      abortController,
      failedText: null,
      steeringQueue: steering,
      pendingSteering: [],
      messages: [...s.messages, userUi, assistantUi],
      checkpoints: checkpoint
        ? [...s.checkpoints.slice(-(MAX_CHECKPOINTS - 1)), checkpoint]
        : s.checkpoints,
    }));

    // API history: fresh project snapshot travels with every user turn so the
    // model always sees manual edits made since the previous turn; a matching
    // gallery example (if any) rides along as a wiring reference. Wire-side
    // trimming happens per LLM call via defaultTransformContext.
    const userMsg = buildUserTurnMessage(text);

    const patchAssistant = (fn: (msg: UiMessage) => UiMessage) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantRef.id ? fn(m) : m)),
      }));

    const onEvent = (ev: AgentEvent) => {
      if (get().generation !== generation) return; // chat was cleared mid-run

      // A queued message entered the conversation: close the current
      // assistant bubble, add the user bubble (with its own checkpoint), and
      // open a fresh assistant bubble for what follows.
      if (ev.type === 'steering_injected' || ev.type === 'follow_up_turn') {
        const newUser: UiMessage = {
          id: nextUiId(),
          role: 'user',
          segments: [{ kind: 'text', text: ev.text }],
        };
        const cp = tryCaptureCheckpoint(newUser.id, ev.text);
        const newAssistant: UiMessage = { id: nextUiId(), role: 'assistant', segments: [] };
        assistantRef.id = newAssistant.id;
        runAssistantIds.add(newAssistant.id);
        set((s) => ({
          messages: [...s.messages, newUser, newAssistant],
          pendingSteering: steering.snapshot(),
          checkpoints: cp ? [...s.checkpoints.slice(-(MAX_CHECKPOINTS - 1)), cp] : s.checkpoints,
        }));
        return;
      }

      // Session-level token totals live outside the message reducer.
      if (ev.type === 'usage') {
        set((s) => ({
          totalTokens: {
            input: s.totalTokens.input + ev.promptTokens,
            output: s.totalTokens.output + ev.completionTokens,
          },
          lastPromptTokens: ev.promptTokens,
        }));
      }
      patchAssistant((m) => applyAgentEvent(m, ev));
    };

    try {
      // Approaching the context limit: summarize older turns with the model
      // and replace them in the stored history. Fails silently — the wire
      // transform's structural trim remains the floor.
      let base = repairedBase;
      // Include the new turn in the decision: its fresh project snapshot is
      // usually the largest payload, and checking only the previous history
      // delayed compaction by one send.
      if (shouldCompact([...base, userMsg], state.lastPromptTokens, state.settings.contextLimitTokens)) {
        onEvent({ type: 'compaction_start' });
        // Apply the same bounded wire context before paying for an LLM
        // summary. This keeps the summarizer request bounded too (especially
        // after a long single-turn tool run).
        const compactInput = buildWireContext(base);
        const compacted = await compactHistory(compactInput, state.settings);
        // Wire-only trimming is ephemeral; keep the student's persistent
        // history lossless unless an actual summary replaced old turns.
        const ok = compacted !== compactInput;
        if (ok && get().generation === generation) {
          base = compacted;
          set({ apiMessages: compacted, lastPromptTokens: 0 });
        }
        onEvent({ type: 'compaction_end', ok });
      }

      const { appended, error, capped } = await runTurn(
        [...base, userMsg],
        state.settings,
        abortController.signal,
        onEvent,
        {
          steering,
          // A follow-up still receives a fresh snapshot, but not another copy
          // of the same gallery reference hint.
          buildFollowUpTurn: (followUpText) => buildUserTurnMessage(followUpText, false),
          transformContext: buildWireContext,
        },
      );
      void error; // surfaced on the bubble by the reducer (run_end event)

      // If the chat was cleared while this run was in flight, discard the
      // result instead of resurrecting a history the user just threw away.
      if (get().generation === generation) {
        set((s) => ({
          apiMessages: trimHistory(
            [...s.apiMessages, userMsg, ...appended],
            MAX_STORED_API_MESSAGES,
          ),
        }));
        // Note: when `error` is set, the work above is still committed and
        // retry stays disarmed (a retry would re-run mutations on the
        // already-changed project).
        if (capped) set({ cappedRun: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (get().generation === generation) {
        patchAssistant((m) => ({ ...m, error: message }));
        // The failed call appended nothing to apiMessages — a retry resends
        // the same user text with a fresh snapshot.
        set({ failedText: text });
      }
    } finally {
      set((s) => {
        // Only clear busy/abort state if it still belongs to THIS run. After
        // clearChat + an immediate new send, s.abortController is the new
        // run's controller — clobbering it would flip busy to false mid-run
        // and break its stop button.
        const ownsRunState = s.abortController === abortController;
        return {
          ...(ownsRunState
            ? { busy: false, abortController: null, steeringQueue: null, pendingSteering: [] }
            : {}),
          // Drop completely empty assistant bubbles (e.g. aborted before output)
          messages: s.messages.filter(
            (m) => !runAssistantIds.has(m.id) || m.segments.length > 0 || m.error,
          ),
        };
      });
      schedulePersistChat(get);
    }
  },
}));

// Persist chat across refreshes (debounced; guarded for SSR/private mode).
if (typeof localStorage !== 'undefined') {
  useAgentStore.subscribe((state, prev) => {
    if (state.messages !== prev.messages || state.apiMessages !== prev.apiMessages) {
      schedulePersistChat(useAgentStore.getState);
    }
  });
}
