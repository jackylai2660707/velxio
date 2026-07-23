/**
 * Project version history — store logic (dedup, pruning, restore backup)
 * and the AI tools (save_version / list_versions / restore_version).
 * Node environment → the in-memory driver is active automatically.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useVersionStore, setVersionDriver, MAX_VERSIONS } from '../versioning/useVersionStore';
import { executeTool } from '../agent/tools';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import type { VersionDriver, VersionMeta } from '../versioning/versionDb';
import type { ProjectCheckpoint } from '../agent/checkpoint';

/** Fresh in-memory driver per test so state never leaks between tests. */
function freshDriver(): VersionDriver {
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

function resetProject() {
  const sim = useSimulatorStore.getState();
  for (const b of [...sim.boards]) sim.removeBoard(b.id);
  useSimulatorStore.setState({ components: [], wires: [] } as never);
}

beforeEach(() => {
  setVersionDriver(freshDriver());
  useVersionStore.setState({ versions: [], loaded: false, busy: false });
  resetProject();
});

describe('useVersionStore', () => {
  it('saves versions and dedupes identical snapshots', async () => {
    useSimulatorStore.getState().addBoard('arduino-uno', 50, 50);
    const store = useVersionStore.getState();

    const first = await store.saveVersion('v1', 'manual');
    expect(first).not.toBeNull();
    // Same project again → skipped
    const dup = await useVersionStore.getState().saveVersion('v1-again', 'manual');
    expect(dup).toBeNull();
    expect(useVersionStore.getState().versions).toHaveLength(1);

    // Change the project → new version
    useSimulatorStore
      .getState()
      .addComponent({ id: 'led-1', metadataId: 'led-red', x: 10, y: 10, properties: {} });
    const second = await useVersionStore.getState().saveVersion('v2', 'ai');
    expect(second).not.toBeNull();
    const versions = useVersionStore.getState().versions;
    expect(versions).toHaveLength(2);
    expect(versions[0].label).toBe('v2'); // newest first
    expect(versions[0].stats.components).toBe(1);
  });

  it('prunes past the cap, protecting manual saves', async () => {
    useSimulatorStore.getState().addBoard('arduino-uno', 50, 50);
    const store = useVersionStore.getState();

    // One manual save first, then flood with auto saves (each must differ).
    await store.saveVersion('keep-me', 'manual');
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      useSimulatorStore
        .getState()
        .addComponent({ id: `c-${i}`, metadataId: 'led-red', x: i, y: i, properties: {} });
      await useVersionStore.getState().saveVersion(`auto-${i}`, 'auto');
    }

    const versions = useVersionStore.getState().versions;
    expect(versions.length).toBeLessThanOrEqual(MAX_VERSIONS);
    expect(versions.some((v) => v.label === 'keep-me')).toBe(true); // manual survived
    expect(versions.some((v) => v.label === 'auto-0')).toBe(false); // oldest auto pruned
  });

  it('restoreVersion rolls the project back and backs up the current state first', async () => {
    const sim = () => useSimulatorStore.getState();
    sim().addBoard('arduino-uno', 50, 50);
    sim().addComponent({ id: 'led-old', metadataId: 'led-red', x: 10, y: 10, properties: {} });
    const v1 = await useVersionStore.getState().saveVersion('good state', 'manual');
    expect(v1).not.toBeNull();

    // Mutate: remove the LED, add two other parts
    sim().removeComponent('led-old');
    sim().addComponent({ id: 'buzz-1', metadataId: 'buzzer', x: 20, y: 20, properties: {} });

    const ok = await useVersionStore.getState().restoreVersion(v1!.id);
    expect(ok).toBe(true);

    // Project is back to the saved state
    const components = useSimulatorStore.getState().components;
    expect(components.map((c) => c.id)).toEqual(['led-old']);

    // And a pre-restore auto backup exists
    const versions = useVersionStore.getState().versions;
    expect(versions.some((v) => v.source === 'auto')).toBe(true);
  });
});

describe('version AI tools', () => {
  it('save_version / list_versions / restore_version round-trip', async () => {
    const sim = () => useSimulatorStore.getState();
    sim().addBoard('arduino-uno', 50, 50);
    useEditorStore
      .getState()
      .addFileToGroup(sim().boards[0].activeFileGroupId, 'sketch.ino', 'void setup(){}');

    const save = await executeTool('save_version', { label: 'v1 完成' });
    expect(save.isError).toBe(false);
    expect(save.result).toContain('v1 完成');

    sim().addComponent({ id: 'led-x', metadataId: 'led-red', x: 5, y: 5, properties: {} });

    const list = await executeTool('list_versions', {});
    expect(list.isError).toBe(false);
    expect(list.result).toContain('v1 完成');
    const id = /- (v-[\w-]+) \[/.exec(list.result)?.[1];
    expect(id).toBeTruthy();

    const restore = await executeTool('restore_version', { id });
    expect(restore.isError).toBe(false);
    expect(useSimulatorStore.getState().components).toHaveLength(0); // led-x gone

    const bad = await executeTool('restore_version', { id: 'v-nope' });
    expect(bad.isError).toBe(true);
  });

  it('save_version requires a label', async () => {
    const r = await executeTool('save_version', {});
    expect(r.isError).toBe(true);
  });
});
