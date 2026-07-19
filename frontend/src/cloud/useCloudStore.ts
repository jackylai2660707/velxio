/**
 * Cloud account + sync state (fork feature).
 *
 * - Auth: token in localStorage, session re-checked on app mount via the
 *   proSession hook (see install.ts).
 * - Projects: manual save/load of full VlxPayload snapshots through the
 *   projects modal (wired into the editor's Save button via proSaveAction).
 * - Chat sessions: the CURRENT conversation auto-syncs (debounced) to one
 *   cloud session per conversation; loading a session from the history view
 *   re-targets the auto-sync at that session.
 */

import { create } from 'zustand';
import {
  authApi,
  chatApi,
  projectApi,
  getToken,
  setToken,
  CloudApiError,
  type CloudUser,
  type CloudProjectMeta,
  type CloudChatMeta,
} from './cloudApi';
import { useAgentStore } from '../store/useAgentStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { buildVlxPayload } from '../utils/vlxFile';
import type { BoardInstance } from '../types/board';

const CHAT_ID_STORAGE = 'velxio-cloud-chat-id';
const PROJECT_ID_STORAGE = 'velxio-cloud-project-id';
const CHAT_SYNC_DEBOUNCE_MS = 3000;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

interface CloudState {
  user: CloudUser | null;
  /** 'unknown' until the mount-time session check resolves */
  sessionStatus: 'unknown' | 'anonymous' | 'signed-in';
  authBusy: boolean;

  authModalOpen: boolean;
  projectsModalOpen: boolean;

  projects: CloudProjectMeta[];
  chats: CloudChatMeta[];
  /** Cloud id of the project currently open in the editor (null = unsaved) */
  currentCloudProjectId: string | null;
  currentCloudProjectName: string;
  /** Cloud id the current conversation auto-syncs into */
  currentChatId: string | null;
  chatSyncState: 'idle' | 'saving' | 'saved' | 'error';

  setAuthModalOpen: (open: boolean) => void;
  setProjectsModalOpen: (open: boolean) => void;

  checkSession: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;

  refreshProjects: () => Promise<void>;
  saveProject: (name: string, asNew: boolean) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  refreshChats: () => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  startNewChat: () => void;
  /** Debounced by the subscriber below; safe to call directly too. */
  syncCurrentChat: () => Promise<void>;
}

export const useCloudStore = create<CloudState>((set, get) => ({
  user: null,
  sessionStatus: 'unknown',
  authBusy: false,
  authModalOpen: false,
  projectsModalOpen: false,
  projects: [],
  chats: [],
  currentCloudProjectId: readLocal(PROJECT_ID_STORAGE),
  currentCloudProjectName: '',
  currentChatId: readLocal(CHAT_ID_STORAGE),
  chatSyncState: 'idle',

  setAuthModalOpen: (open) => set({ authModalOpen: open }),
  setProjectsModalOpen: (open) => {
    set({ projectsModalOpen: open });
    if (open) void get().refreshProjects();
  },

  checkSession: async () => {
    if (!getToken()) {
      set({ sessionStatus: 'anonymous', user: null });
      return;
    }
    try {
      const { user } = await authApi.me();
      set({ user, sessionStatus: 'signed-in' });
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 401) setToken(null);
      set({ user: null, sessionStatus: 'anonymous' });
    }
  },

  login: async (email, password) => {
    set({ authBusy: true });
    try {
      const { token, user } = await authApi.login(email, password);
      setToken(token);
      set({ user, sessionStatus: 'signed-in', authModalOpen: false });
    } finally {
      set({ authBusy: false });
    }
  },

  register: async (email, password, name) => {
    set({ authBusy: true });
    try {
      const { token, user } = await authApi.register(email, password, name);
      setToken(token);
      set({ user, sessionStatus: 'signed-in', authModalOpen: false });
    } finally {
      set({ authBusy: false });
    }
  },

  logout: () => {
    setToken(null);
    writeLocal(CHAT_ID_STORAGE, null);
    writeLocal(PROJECT_ID_STORAGE, null);
    set({
      user: null,
      sessionStatus: 'anonymous',
      projects: [],
      chats: [],
      currentChatId: null,
      currentCloudProjectId: null,
      currentCloudProjectName: '',
    });
  },

  // ── Projects ─────────────────────────────────────────────────────────

  refreshProjects: async () => {
    if (!get().user) return;
    try {
      const { projects } = await projectApi.list();
      set({ projects });
    } catch {
      /* list stays stale; modal shows what it has */
    }
  },

  saveProject: async (name, asNew) => {
    const payload = buildVlxPayload({ name });
    const existing = get().currentCloudProjectId;
    if (existing && !asNew) {
      try {
        await projectApi.update(existing, { name, data: payload });
        set({ currentCloudProjectName: name });
        await get().refreshProjects();
        return;
      } catch (err) {
        // Project was deleted server-side — fall through to create.
        if (!(err instanceof CloudApiError && err.status === 404)) throw err;
      }
    }
    const { id } = await projectApi.create(name, payload);
    writeLocal(PROJECT_ID_STORAGE, id);
    set({ currentCloudProjectId: id, currentCloudProjectName: name });
    await get().refreshProjects();
  },

  loadProject: async (id) => {
    const { name, data } = await projectApi.get(id);
    // Same identity guard as importVlxFile: clear the current project BEFORE
    // mutating stores so no auto-save hook writes over the old identity.
    useProjectStore.getState().clearCurrentProject();
    useSimulatorStore.getState().loadProjectState({
      boards: data.boards as unknown as BoardInstance[],
      fileGroups: data.fileGroups,
      components: data.components,
      wires: data.wires,
      activeBoardId: data.activeBoardId,
    });
    writeLocal(PROJECT_ID_STORAGE, id);
    set({ currentCloudProjectId: id, currentCloudProjectName: name, projectsModalOpen: false });
  },

  deleteProject: async (id) => {
    await projectApi.remove(id);
    if (get().currentCloudProjectId === id) {
      writeLocal(PROJECT_ID_STORAGE, null);
      set({ currentCloudProjectId: null, currentCloudProjectName: '' });
    }
    await get().refreshProjects();
  },

  // ── Chat sessions ────────────────────────────────────────────────────

  refreshChats: async () => {
    if (!get().user) return;
    try {
      const { chats } = await chatApi.list();
      set({ chats });
    } catch {
      /* keep stale list */
    }
  },

  loadChat: async (id) => {
    const chat = await chatApi.get(id);
    useAgentStore.getState().hydrateSession(chat.messages, chat.api_messages);
    writeLocal(CHAT_ID_STORAGE, id);
    set({ currentChatId: id });
  },

  deleteChat: async (id) => {
    await chatApi.remove(id);
    if (get().currentChatId === id) {
      writeLocal(CHAT_ID_STORAGE, null);
      set({ currentChatId: null });
    }
    await get().refreshChats();
  },

  startNewChat: () => {
    useAgentStore.getState().clearChat();
    writeLocal(CHAT_ID_STORAGE, null);
    set({ currentChatId: null });
  },

  syncCurrentChat: async () => {
    const { user, currentChatId } = get();
    if (!user) return;
    const agent = useAgentStore.getState();
    if (agent.messages.length === 0) return;

    const firstUserText =
      agent.messages.find((m) => m.role === 'user')?.segments.find((s) => s.kind === 'text');
    const title =
      (firstUserText && firstUserText.kind === 'text' ? firstUserText.text : '').slice(0, 60) ||
      'Untitled chat';

    set({ chatSyncState: 'saving' });
    try {
      const { id } = await chatApi.upsert({
        id: currentChatId ?? undefined,
        title,
        messages: agent.messages,
        api_messages: agent.apiMessages,
      });
      writeLocal(CHAT_ID_STORAGE, id);
      set({ currentChatId: id, chatSyncState: 'saved' });
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 404 && currentChatId) {
        // Session deleted server-side — recreate on the next tick.
        writeLocal(CHAT_ID_STORAGE, null);
        set({ currentChatId: null, chatSyncState: 'idle' });
        return;
      }
      set({ chatSyncState: 'error' });
    }
  },
}));

// ── Auto-sync the current conversation while signed in ────────────────────
// Debounced subscriber on the agent store; skipped mid-run (busy) so we only
// upload settled turns.
let chatSyncTimer: ReturnType<typeof setTimeout> | null = null;
if (typeof window !== 'undefined') {
  useAgentStore.subscribe((state, prev) => {
    if (state.messages === prev.messages && state.apiMessages === prev.apiMessages) return;
    if (!useCloudStore.getState().user) return;
    if (chatSyncTimer) clearTimeout(chatSyncTimer);
    chatSyncTimer = setTimeout(() => {
      const agent = useAgentStore.getState();
      if (agent.busy) return; // the end-of-turn update will re-trigger us
      void useCloudStore.getState().syncCurrentChat();
    }, CHAT_SYNC_DEBOUNCE_MS);
  });
}
