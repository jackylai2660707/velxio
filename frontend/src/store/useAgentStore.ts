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
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { buildExampleHint } from '../agent/exampleHints';
import {
  captureCheckpoint,
  restoreCheckpoint,
  type ProjectCheckpoint,
} from '../agent/checkpoint';
import { toolLabel } from '../agent/tools';
import type { ApiMessage, UiMessage, UiToolSegment } from '../agent/types';

const SETTINGS_STORAGE = 'velxio-agent-settings';
const LEGACY_KEY_STORAGE = 'velxio-agent-api-key';
const PANEL_WIDTH_STORAGE = 'velxio-agent-panel-width';
const CHAT_STORAGE = 'velxio-agent-chat';
const MAX_CHECKPOINTS = 10;
const MAX_PERSISTED_UI_MESSAGES = 80;

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
        apiMessages: parsed.apiMessages ?? [],
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
        apiMessages: trimHistory(apiMessages),
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
}

interface TurnCheckpoint {
  msgId: string;
  label: string;
  state: ProjectCheckpoint;
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
  /** Session token totals (sum of upstream-reported usage) */
  totalTokens: { input: number; output: number };

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
  totalTokens: { input: 0, output: 0 },

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
      apiMessages,
      checkpoints: [], // they referenced the previous conversation's turns
      busy: false,
      abortController: null,
      failedText: null,
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

    const abortController = new AbortController();
    const generation = state.generation;

    // Capture the whole project BEFORE the AI touches anything, so this turn
    // can be rolled back from the message bubble.
    let checkpoint: TurnCheckpoint | null = null;
    const userUi: UiMessage = { id: nextUiId(), role: 'user', segments: [{ kind: 'text', text }] };
    try {
      checkpoint = { msgId: userUi.id, label: text.slice(0, 40), state: captureCheckpoint() };
    } catch {
      /* checkpoint is best-effort — never block a send on it */
    }

    const assistantUi: UiMessage = { id: nextUiId(), role: 'assistant', segments: [] };
    set((s) => ({
      busy: true,
      abortController,
      failedText: null,
      messages: [...s.messages, userUi, assistantUi],
      checkpoints: checkpoint
        ? [...s.checkpoints.slice(-(MAX_CHECKPOINTS - 1)), checkpoint]
        : s.checkpoints,
    }));

    // API history: fresh project snapshot travels with every user turn so the
    // model always sees manual edits made since the previous turn; a matching
    // gallery example (if any) rides along as a wiring reference.
    const exampleHint = buildExampleHint(text);
    const userMsg: ApiMessage = {
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
    const history = trimHistory([...state.apiMessages, userMsg]);

    const patchAssistant = (fn: (msg: UiMessage) => UiMessage) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantUi.id ? fn(m) : m)),
      }));

    const appendText = (delta: string) =>
      patchAssistant((m) => {
        const segments = [...m.segments];
        const last = segments[segments.length - 1];
        if (last?.kind === 'text') {
          segments[segments.length - 1] = { ...last, text: last.text + delta };
        } else {
          segments.push({ kind: 'text', text: delta });
        }
        return { ...m, segments };
      });

    try {
      const { appended } = await runTurn(history, state.settings, abortController.signal, {
        onTextBlockStart: () =>
          patchAssistant((m) => ({
            ...m,
            segments: [...m.segments, { kind: 'text', text: '' }],
          })),
        onTextDelta: appendText,
        onThinking: (chars) =>
          patchAssistant((m) => ({ ...m, thinkingChars: (m.thinkingChars ?? 0) + chars })),
        onUsage: (input, output) => {
          patchAssistant((m) => ({
            ...m,
            usage: {
              input: (m.usage?.input ?? 0) + input,
              output: (m.usage?.output ?? 0) + output,
            },
          }));
          set((s) => ({
            totalTokens: {
              input: s.totalTokens.input + input,
              output: s.totalTokens.output + output,
            },
          }));
        },
        onToolStart: (_id, name, input) =>
          patchAssistant((m) => ({
            ...m,
            segments: [
              ...m.segments,
              {
                kind: 'tool',
                name,
                label: toolLabel(name, input),
                status: 'running',
              } satisfies UiToolSegment,
            ],
          })),
        onToolEnd: (_id, result, isError, diff) =>
          patchAssistant((m) => {
            const segments = [...m.segments];
            for (let i = segments.length - 1; i >= 0; i--) {
              const seg = segments[i];
              if (seg.kind === 'tool' && seg.status === 'running') {
                segments[i] = {
                  ...seg,
                  status: isError ? 'error' : 'ok',
                  detail: result.slice(0, 2000),
                  diff,
                };
                break;
              }
            }
            return { ...m, segments };
          }),
      });

      // If the chat was cleared while this run was in flight, discard the
      // result instead of resurrecting a history the user just threw away.
      if (get().generation === generation) {
        set((s) => ({
          apiMessages: trimHistory([...s.apiMessages, userMsg, ...appended]),
        }));
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
          ...(ownsRunState ? { busy: false, abortController: null } : {}),
          // Drop a completely empty assistant bubble (e.g. aborted before output)
          messages: s.messages.filter(
            (m) => m.id !== assistantUi.id || m.segments.length > 0 || m.error,
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
