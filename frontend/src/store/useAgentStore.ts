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
const MAX_CHECKPOINTS = 10;
const MAX_PERSISTED_UI_MESSAGES = 80;
/** Stored API history cap. Wire-size is controlled per LLM call by
 *  defaultTransformContext (snapshot stripping + structural trim), so the
 *  store can afford to keep much more raw history than fits one request. */
const MAX_STORED_API_MESSAGES = 200;

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

interface PersistedChat {
  messages: UiMessage[];
  apiMessages: ApiMessage[];
  uiIdCounter: number;
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
      return {
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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistChat(get: () => AgentState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const { messages, apiMessages } = get();
      const payload: PersistedChat = {
        messages: messages.slice(-MAX_PERSISTED_UI_MESSAGES),
        apiMessages: trimHistory(apiMessages, MAX_STORED_API_MESSAGES),
        uiIdCounter,
      };
      localStorage.setItem(CHAT_STORAGE, JSON.stringify(payload));
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
 *  steering messages promoted to follow-up turns. */
function buildUserTurnMessage(text: string): ApiMessage {
  const exampleHint = buildExampleHint(text);
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `<project_state>\n${buildProjectSnapshot()}\n</project_state>\n\n` +
          (exampleHint ? `${exampleHint}\n\n` : '') +
          text,
      },
    ],
  };
}

interface AgentState {
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

const initialChat = typeof localStorage !== 'undefined' ? loadChat() : { messages: [], apiMessages: [], uiIdCounter: 0 };
uiIdCounter = initialChat.uiIdCounter;

export const useAgentStore = create<AgentState>((set, get) => ({
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
  messages: initialChat.messages,
  apiMessages: initialChat.apiMessages,
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;
      const resp = await fetch(`${getApiBase()}/agent/models`, {
        method: 'POST',
        headers,
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
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['x-agent-key'] = settings.apiKey;
      const resp = await fetch(`${getApiBase()}/agent/test`, {
        method: 'POST',
        headers,
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
      if (shouldCompact(base, state.lastPromptTokens, state.settings.contextLimitTokens)) {
        onEvent({ type: 'compaction_start' });
        const compacted = await compactHistory(base, state.settings);
        const ok = compacted !== base;
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
          buildFollowUpTurn: buildUserTurnMessage,
          transformContext: defaultTransformContext,
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
