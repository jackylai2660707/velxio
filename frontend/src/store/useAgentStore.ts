/**
 * Chat state for the AI assistant panel.
 *
 * Two parallel histories:
 *  - `apiMessages` — raw Anthropic-shaped messages replayed to the backend
 *    every turn (includes tool_use / tool_result / thinking blocks).
 *  - `messages`    — UI rendering (text segments + tool chips).
 */

import { create } from 'zustand';
import { getApiBase } from '../lib/apiBase';
import { runTurn, trimHistory } from '../agent/AgentRunner';
import { buildProjectSnapshot } from '../agent/projectSnapshot';
import { toolLabel } from '../agent/tools';
import type { ApiMessage, UiMessage, UiToolSegment } from '../agent/types';

const API_KEY_STORAGE = 'velxio-agent-api-key';

let uiIdCounter = 0;
const nextUiId = () => `agent-msg-${++uiIdCounter}`;

interface AgentState {
  panelOpen: boolean;
  busy: boolean;
  /** Whether the backend holds an ANTHROPIC_API_KEY (null = not yet fetched) */
  serverHasKey: boolean | null;
  backendEnabled: boolean | null;
  apiKey: string;
  messages: UiMessage[];
  apiMessages: ApiMessage[];
  abortController: AbortController | null;

  togglePanel: () => void;
  setApiKey: (key: string) => void;
  fetchConfig: () => Promise<void>;
  clearChat: () => void;
  stop: () => void;
  send: (text: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  panelOpen: false,
  busy: false,
  serverHasKey: null,
  backendEnabled: null,
  apiKey: typeof localStorage !== 'undefined' ? (localStorage.getItem(API_KEY_STORAGE) ?? '') : '',
  messages: [],
  apiMessages: [],
  abortController: null,

  togglePanel: () => {
    const open = !get().panelOpen;
    set({ panelOpen: open });
    if (open && get().serverHasKey === null) void get().fetchConfig();
  },

  setApiKey: (key: string) => {
    set({ apiKey: key });
    try {
      if (key) localStorage.setItem(API_KEY_STORAGE, key);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      /* private mode — key lives for the session only */
    }
  },

  fetchConfig: async () => {
    try {
      const resp = await fetch(`${getApiBase()}/agent/config`, { credentials: 'include' });
      const j = await resp.json();
      set({ serverHasKey: !!j.server_has_key, backendEnabled: !!j.enabled });
    } catch {
      set({ serverHasKey: false, backendEnabled: false });
    }
  },

  clearChat: () => {
    get().abortController?.abort();
    set({ messages: [], apiMessages: [], busy: false, abortController: null });
  },

  stop: () => {
    get().abortController?.abort();
  },

  send: async (text: string) => {
    const state = get();
    if (state.busy || !text.trim()) return;

    const abortController = new AbortController();

    // UI: push user message + an empty assistant message we stream into
    const userUi: UiMessage = { id: nextUiId(), role: 'user', segments: [{ kind: 'text', text }] };
    const assistantUi: UiMessage = { id: nextUiId(), role: 'assistant', segments: [] };
    set({
      busy: true,
      abortController,
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
      const { appended } = await runTurn(history, state.apiKey || null, abortController.signal, {
        onTextBlockStart: () =>
          patchAssistant((m) => ({
            ...m,
            segments: [...m.segments, { kind: 'text', text: '' }],
          })),
        onTextDelta: appendText,
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
        onThinking: (chars) =>
          patchAssistant((m) => ({ ...m, thinkingChars: (m.thinkingChars ?? 0) + chars })),
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

      set((s) => ({
        apiMessages: trimHistory([...s.apiMessages, userMsg, ...appended]),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchAssistant((m) => ({ ...m, error: message }));
      // Keep the user message in API history so a retry has context; drop
      // nothing — the failed call appended no assistant message.
      set((s) => ({ apiMessages: [...s.apiMessages, userMsg] }));
    } finally {
      // Drop a completely empty assistant bubble (e.g. aborted before output)
      set((s) => ({
        busy: false,
        abortController: null,
        messages: s.messages.filter(
          (m) => m.id !== assistantUi.id || m.segments.length > 0 || m.error,
        ),
      }));
    }
  },
}));
