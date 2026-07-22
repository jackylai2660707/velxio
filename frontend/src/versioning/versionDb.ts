/**
 * Version-history storage.
 *
 * Full-project snapshots live in IndexedDB (localStorage's ~5MB quota is
 * already spoken for by chat persistence, and 50 versions of a multi-file
 * project blow straight through it). Two object stores: `meta` (small, read
 * as a list) and `payloads` (large ProjectCheckpoints, fetched only on
 * restore).
 *
 * The driver is swappable: without `indexedDB` (node tests, SSR) an
 * in-memory Map driver is used, so the store logic is testable and safe
 * everywhere.
 */

import type { ProjectCheckpoint } from '../agent/checkpoint';

export type VersionSource = 'manual' | 'ai' | 'auto';

export interface VersionStats {
  boards: number;
  components: number;
  wires: number;
  files: number;
}

export interface VersionMeta {
  id: string;
  label: string;
  createdAt: number; // epoch ms
  source: VersionSource;
  stats: VersionStats;
  /** Cheap content hash for save-time dedup against the newest version */
  hash: string;
}

export interface VersionDriver {
  listMeta(): Promise<VersionMeta[]>;
  getPayload(id: string): Promise<ProjectCheckpoint | null>;
  put(meta: VersionMeta, payload: ProjectCheckpoint): Promise<void>;
  delete(id: string): Promise<void>;
  rename(id: string, label: string): Promise<void>;
}

// ── In-memory driver (node / SSR / tests) ──────────────────────────────────

function memoryDriver(): VersionDriver {
  const metas = new Map<string, VersionMeta>();
  const payloads = new Map<string, ProjectCheckpoint>();
  return {
    async listMeta() {
      return [...metas.values()];
    },
    async getPayload(id) {
      return payloads.get(id) ?? null;
    },
    async put(meta, payload) {
      metas.set(meta.id, meta);
      payloads.set(meta.id, payload);
    },
    async delete(id) {
      metas.delete(id);
      payloads.delete(id);
    },
    async rename(id, label) {
      const m = metas.get(id);
      if (m) metas.set(id, { ...m, label });
    },
  };
}

// ── IndexedDB driver ───────────────────────────────────────────────────────

const DB_NAME = 'velxio-versions';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('payloads')) db.createObjectStore('payloads');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T | undefined;
    const req = run(t);
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(t.error ?? new Error('indexedDB tx failed'));
    t.onabort = () => reject(t.error ?? new Error('indexedDB tx aborted'));
  });
}

function idbDriver(): VersionDriver {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());
  return {
    async listMeta() {
      return tx<VersionMeta[]>(await db(), ['meta'], 'readonly', (t) =>
        t.objectStore('meta').getAll(),
      );
    },
    async getPayload(id) {
      const p = await tx<ProjectCheckpoint | undefined>(await db(), ['payloads'], 'readonly', (t) =>
        t.objectStore('payloads').get(id),
      );
      return p ?? null;
    },
    async put(meta, payload) {
      await tx(await db(), ['meta', 'payloads'], 'readwrite', (t) => {
        t.objectStore('meta').put(meta);
        t.objectStore('payloads').put(payload, meta.id);
      });
    },
    async delete(id) {
      await tx(await db(), ['meta', 'payloads'], 'readwrite', (t) => {
        t.objectStore('meta').delete(id);
        t.objectStore('payloads').delete(id);
      });
    },
    async rename(id, label) {
      const database = await db();
      const meta = await tx<VersionMeta | undefined>(database, ['meta'], 'readonly', (t) =>
        t.objectStore('meta').get(id),
      );
      if (!meta) return;
      await tx(database, ['meta'], 'readwrite', (t) =>
        t.objectStore('meta').put({ ...meta, label }),
      );
    },
  };
}

export function createDefaultDriver(): VersionDriver {
  return typeof indexedDB === 'undefined' ? memoryDriver() : idbDriver();
}

/** FNV-1a over the checkpoint JSON — fast dedup key, not cryptographic. */
export function checkpointHash(cp: ProjectCheckpoint): string {
  const s = JSON.stringify(cp);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
