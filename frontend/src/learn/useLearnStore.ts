/**
 * Learning progress + quiz state. Local-first: everything is written to
 * localStorage immediately so an anonymous student never loses progress;
 * when signed in, mutations also POST to /api/lms and a sign-in triggers
 * a two-way merge (local-only completions are pushed up, server state is
 * pulled down) so the teacher dashboard sees the full picture.
 */

import { create } from 'zustand';
import { lmsApi, type LmsQuizBest } from '../cloud/cloudApi';
import { useCloudStore } from '../cloud/useCloudStore';

const STORAGE_KEY = 'ailab-learn-progress-v1';

interface PersistedState {
  done: Record<string, true>;
  quizBest: Record<string, LmsQuizBest>;
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { done: {}, quizBest: {} };
    const j = JSON.parse(raw) as Partial<PersistedState>;
    return { done: j.done ?? {}, quizBest: j.quizBest ?? {} };
  } catch {
    return { done: {}, quizBest: {} };
  }
}

function persist(state: PersistedState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ done: state.done, quizBest: state.quizBest })
    );
  } catch {
    /* private mode */
  }
}

interface LearnState extends PersistedState {
  /** True once a signed-in session has merged with the server. */
  synced: boolean;

  markDone: (lessonKey: string) => void;
  resetLesson: (lessonKey: string) => void;
  /** Record a finished quiz locally (keeps the best score) + server. */
  submitQuiz: (
    lessonKey: string,
    score: number,
    total: number,
    answers: number[]
  ) => void;
  /** Two-way merge with /api/lms after sign-in. */
  syncWithServer: () => Promise<void>;
  /** Completed-lesson count among the given keys. */
  countDone: (lessonKeys: string[]) => number;
}

export const useLearnStore = create<LearnState>((set, get) => ({
  ...loadPersisted(),
  synced: false,

  markDone: (key) => {
    const done = { ...get().done, [key]: true as const };
    set({ done });
    persist({ done, quizBest: get().quizBest });
    if (useCloudStore.getState().user) {
      void lmsApi.setProgress(key, 'done').catch(() => {});
    }
  },

  resetLesson: (key) => {
    const done = { ...get().done };
    delete done[key];
    set({ done });
    persist({ done, quizBest: get().quizBest });
    if (useCloudStore.getState().user) {
      void lmsApi.setProgress(key, 'reset').catch(() => {});
    }
  },

  submitQuiz: (key, score, total, answers) => {
    const prev = get().quizBest[key];
    const quizBest = {
      ...get().quizBest,
      [key]: {
        best_score: Math.max(prev?.best_score ?? 0, score),
        total,
        attempts: (prev?.attempts ?? 0) + 1,
      },
    };
    set({ quizBest });
    persist({ done: get().done, quizBest });
    if (useCloudStore.getState().user) {
      void lmsApi.submitQuiz(key, score, total, answers).catch(() => {});
    }
  },

  syncWithServer: async () => {
    if (!useCloudStore.getState().user) return;
    try {
      const server = await lmsApi.getProgress();
      const local = get();

      // Push local-only completions up (work done while signed out).
      const serverDone = new Set(server.done);
      await Promise.all(
        Object.keys(local.done)
          .filter((k) => !serverDone.has(k))
          .map((k) => lmsApi.setProgress(k, 'done').catch(() => {}))
      );

      // Merge down: union of done, best-of quiz records.
      const done: Record<string, true> = { ...local.done };
      for (const k of server.done) done[k] = true;
      const quizBest = { ...local.quizBest };
      for (const [k, v] of Object.entries(server.quiz)) {
        const l = quizBest[k];
        quizBest[k] = l
          ? {
              best_score: Math.max(l.best_score, v.best_score),
              total: v.total,
              attempts: Math.max(l.attempts, v.attempts),
            }
          : v;
      }
      set({ done, quizBest, synced: true });
      persist({ done, quizBest });
    } catch {
      /* offline / server down — local state remains authoritative */
    }
  },

  countDone: (keys) => {
    const done = get().done;
    return keys.reduce((n, k) => n + (done[k] ? 1 : 0), 0);
  },
}));

// Merge with the server whenever a session appears (sign-in or the
// mount-time session check resolving to signed-in).
if (typeof window !== 'undefined') {
  let lastUserId: string | null = null;
  useCloudStore.subscribe((state) => {
    const uid = state.user?.id ?? null;
    if (uid && uid !== lastUserId) {
      lastUserId = uid;
      void useLearnStore.getState().syncWithServer();
    }
    if (!uid) {
      lastUserId = null;
      // Keep local progress, but a future different account must re-sync.
      useLearnStore.setState({ synced: false });
    }
  });
}
