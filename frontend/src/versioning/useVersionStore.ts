/**
 * Project version history — git-style linear snapshots for students.
 *
 * Versions are full ProjectCheckpoints (agent/checkpoint.ts — the same
 * capture/restore primitive the AI's per-turn ⟲ uses), created:
 *  - automatically before every AI turn (labeled with the request),
 *  - manually from the Version History modal (named by the student),
 *  - automatically as a safety backup right before any restore.
 *
 * Deduped by content hash against the newest version; capped at
 * MAX_VERSIONS with manual saves protected from pruning.
 */

import { create } from 'zustand';
import {
  captureCheckpoint,
  restoreCheckpoint,
  type ProjectCheckpoint,
} from '../agent/checkpoint';
import {
  checkpointHash,
  createDefaultDriver,
  type VersionDriver,
  type VersionMeta,
  type VersionSource,
} from './versionDb';

export const MAX_VERSIONS = 50;

let driver: VersionDriver = createDefaultDriver();
/** Test hook — swap the storage driver (returns the previous one). */
export function setVersionDriver(d: VersionDriver): VersionDriver {
  const prev = driver;
  driver = d;
  return prev;
}

let versionCounter = 0;
const nextVersionId = () => `v-${Date.now().toString(36)}-${(++versionCounter).toString(36)}`;

function statsOf(cp: ProjectCheckpoint) {
  let files = 0;
  for (const list of Object.values(cp.boardFiles)) files += list.length;
  for (const list of Object.values(cp.otherGroups)) files += list.length;
  return {
    boards: cp.boards.length,
    components: cp.components.length,
    wires: cp.wires.length,
    files,
  };
}

interface VersionState {
  versions: VersionMeta[]; // newest first
  loaded: boolean;
  busy: boolean;

  refresh: () => Promise<void>;
  /** Snapshot the CURRENT project. Returns the meta, or null when skipped
   *  (identical to the newest version) — dedup keeps auto-saves quiet. */
  saveVersion: (label: string, source: VersionSource) => Promise<VersionMeta | null>;
  /** Same, but reuse a checkpoint the caller already captured. */
  saveVersionFromCheckpoint: (
    cp: ProjectCheckpoint,
    label: string,
    source: VersionSource,
  ) => Promise<VersionMeta | null>;
  /** Roll the whole project back to a version (auto-backup of current first). */
  restoreVersion: (id: string) => Promise<boolean>;
  deleteVersion: (id: string) => Promise<void>;
  renameVersion: (id: string, label: string) => Promise<void>;
}

export const useVersionStore = create<VersionState>((set, get) => ({
  versions: [],
  loaded: false,
  busy: false,

  refresh: async () => {
    try {
      const metas = await driver.listMeta();
      metas.sort((a, b) => b.createdAt - a.createdAt);
      set({ versions: metas, loaded: true });
    } catch {
      set({ loaded: true }); // storage unavailable — feature degrades silently
    }
  },

  saveVersion: async (label, source) => {
    let cp: ProjectCheckpoint;
    try {
      cp = captureCheckpoint();
    } catch {
      return null;
    }
    return get().saveVersionFromCheckpoint(cp, label, source);
  },

  saveVersionFromCheckpoint: async (cp, label, source) => {
    try {
      if (!get().loaded) await get().refresh();
      const hash = checkpointHash(cp);
      const newest = get().versions[0];
      if (newest && newest.hash === hash) return null; // unchanged — skip

      const meta: VersionMeta = {
        id: nextVersionId(),
        label: label.trim().slice(0, 60) || '(unnamed)',
        createdAt: Date.now(),
        source,
        stats: statsOf(cp),
        hash,
      };
      await driver.put(meta, cp);

      // Prune past the cap — oldest non-manual first, manual saves protected.
      let versions = [meta, ...get().versions];
      if (versions.length > MAX_VERSIONS) {
        const prunable = [...versions].reverse().filter((v) => v.source !== 'manual');
        const toDrop = prunable.slice(0, versions.length - MAX_VERSIONS);
        for (const v of toDrop) await driver.delete(v.id);
        const dropped = new Set(toDrop.map((v) => v.id));
        versions = versions.filter((v) => !dropped.has(v.id));
      }
      set({ versions });
      return meta;
    } catch {
      return null; // never break the caller (AI turn) on storage failure
    }
  },

  restoreVersion: async (id) => {
    const state = get();
    if (state.busy) return false;
    set({ busy: true });
    try {
      const payload = await driver.getPayload(id);
      if (!payload) return false;
      // Safety net: snapshot the current state before rolling back, so the
      // restore itself is undoable.
      await state.saveVersion('backup before restore', 'auto');
      await restoreCheckpoint(payload);
      return true;
    } catch {
      return false;
    } finally {
      set({ busy: false });
    }
  },

  deleteVersion: async (id) => {
    try {
      await driver.delete(id);
      set((s) => ({ versions: s.versions.filter((v) => v.id !== id) }));
    } catch {
      /* ignore */
    }
  },

  renameVersion: async (id, label) => {
    const clean = label.trim().slice(0, 60);
    if (!clean) return;
    try {
      await driver.rename(id, clean);
      set((s) => ({
        versions: s.versions.map((v) => (v.id === id ? { ...v, label: clean } : v)),
      }));
    } catch {
      /* ignore */
    }
  },
}));
