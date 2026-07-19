/**
 * Chat state for the AI assistant panel.
 *
 * Two parallel histories:
 *  - `apiMessages` — raw Anthropic-shaped messages replayed to the backend
 *    every turn (includes tool_use / tool_result blocks).
 *  - `messages`    — UI rendering (text segments + tool chips).
 *
 * Provider settings (OpenAI-compatible endpoint first-class: base URL, key,
 * model, effort) live in localStorage and are sent with every request; the
 * backend fills anything left blank from its environment defaults.
 */

import { create } from 'zustand';
import { getApiBase } from '../lib/apiBase';
import { runTurn, trimHistory, type AgentSettings } from '../agent/AgentRunner';
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { toolLabel } from '../agent/tools';
import type { ApiMessage, UiMessage, UiToolSegment } from '../agent/types';

const SETTINGS_STORAGE = 'velxio-agent-settings';
const LEGACY_KEY_STORAGE = 'velxio-agent-api-key';
const PANEL_WIDTH_STORAGE = 'velxio-agent-panel-width';

let uiIdCounter = 0;
const nextUiId = () => `agent-msg-${++uiIdCounter}`;

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE);
    if (raw) return JSON.parse(raw) as AgentSettings;
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

export interface AgentServerConfig {
  provider: string;
  base_url: string;
  model: string;
  effort: string;
  server_has_key: boolean;
}

interface AgentState {
  panelOpen: boolean;
  panelWidth: number;
  busy: boolean;
  settingsOpen: boolean;
  /** Environment defaults reported by the backend (null = not fetched yet) */
  serverConfig: AgentServerConfig | null;
  settings: AgentSettings;
  messages: UiMessage[];
  apiMessages: ApiMessage[];
  abortController: AbortController | null;
  /** Bumped by clearChat so an in-flight run can't resurrect cleared history */
  generation: number;
  /** Text of the last send that failed — enables one-click retry */
  failedText: string | null;

  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<AgentSettings>) => void;
  fetchConfig: () => Promise<void>;
  testConnection: () => Promise<{ ok: boolean; message: string; latency_ms?: number }>;
  clearChat: () => void;
  stop: () => void;
  send: (text: string) => Promise<void>;
  retry: () => void;
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
  messages: [],
  apiMessages: [],
  abortController: null,
  generation: 0,
  failedText: null,

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
        serverConfig: {
          provider: 'openai',
          base_url: '',
          model: '',
          effort: '',
          server_has_key: false,
        },
      });
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
          provider: settings.provider || undefined,
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
      busy: false,
      abortController: null,
      failedText: null,
      generation: s.generation + 1,
    }));
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

  send: async (text: string) => {
    const state = get();
    if (state.busy || !text.trim()) return;

    const abortController = new AbortController();
    const generation = state.generation;

    // UI: push user message + an empty assistant message we stream into
    const userUi: UiMessage = { id: nextUiId(), role: 'user', segments: [{ kind: 'text', text }] };
    const assistantUi: UiMessage = { id: nextUiId(), role: 'assistant', segments: [] };
    set({
      busy: true,
      abortController,
      failedText: null,
      messages: [...state.messages, userUi, assistantUi],
    });

    // API history: fresh project snapshot travels with every user turn so the
    // model always sees manual edits made since the previous turn.
    const userMsg: ApiMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<project_state>\n${buildProjectSnapshot()}\n</project_state>\n\n${text}`,
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
        onToolEnd: (_id, result, isError) =>
          patchAssistant((m) => {
            const segments = [...m.segments];
            for (let i = segments.length - 1; i >= 0; i--) {
              const seg = segments[i];
              if (seg.kind === 'tool' && seg.status === 'running') {
                segments[i] = {
                  ...seg,
                  status: isError ? 'error' : 'ok',
                  detail: result.slice(0, 2000),
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
      set((s) => ({
        busy: false,
        abortController: null,
        // Drop a completely empty assistant bubble (e.g. aborted before output)
        messages: s.messages.filter(
          (m) => m.id !== assistantUi.id || m.segments.length > 0 || m.error,
        ),
      }));
    }
  },
}));
