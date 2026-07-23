/**
 * Per-turn project checkpoints for the AI assistant.
 *
 * Before every user turn the panel captures the whole project (boards,
 * components, wires, code files); a "restore" button on the message rolls
 * everything back if the AI made a mess. Board identity survives restore
 * because addBoard accepts an explicit id and derives the editor file group
 * deterministically from it (`group-<boardId>`).
 */

import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { getToolbarActions } from '../lib/agentBridge';
import type { BoardKind, LanguageMode } from '../types/board';
import type { Wire } from '../types/wire';

interface CheckpointBoard {
  id: string;
  boardKind: BoardKind;
  x: number;
  y: number;
  name?: string;
  languageMode: LanguageMode;
  libraries?: string[];
}

interface CheckpointComponent {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

export interface ProjectCheckpoint {
  boards: CheckpointBoard[];
  activeBoardId: string | null;
  components: CheckpointComponent[];
  wires: Wire[];
  /** Files per BOARD id (board file-group ids are derived, not stable enough) */
  boardFiles: Record<string, { name: string; content: string }[]>;
  /** Non-board groups (custom-chip programs) verbatim by group id */
  otherGroups: Record<string, { name: string; content: string }[]>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function captureCheckpoint(): ProjectCheckpoint {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  const boardFiles: ProjectCheckpoint['boardFiles'] = {};
  const boardGroupIds = new Set<string>();
  for (const b of sim.boards) {
    boardGroupIds.add(b.activeFileGroupId);
    boardFiles[b.id] = editor
      .getGroupFiles(b.activeFileGroupId)
      .map((f) => ({ name: f.name, content: f.content }));
  }

  const otherGroups: ProjectCheckpoint['otherGroups'] = {};
  for (const gid of Object.keys(editor.fileGroups)) {
    if (!boardGroupIds.has(gid)) {
      otherGroups[gid] = editor
        .getGroupFiles(gid)
        .map((f) => ({ name: f.name, content: f.content }));
    }
  }

  return {
    boards: sim.boards.map((b) => ({
      id: b.id,
      boardKind: b.boardKind,
      x: b.x,
      y: b.y,
      name: b.name,
      languageMode: b.languageMode,
      libraries: b.libraries ? [...b.libraries] : undefined,
    })),
    activeBoardId: sim.activeBoardId ?? null,
    components: clone(sim.components) as CheckpointComponent[],
    wires: clone(sim.wires) as Wire[],
    boardFiles,
    otherGroups,
  };
}

/** Wait two frames so React mounts restored elements before wire recalc. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') return resolve();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export async function restoreCheckpoint(cp: ProjectCheckpoint): Promise<void> {
  // A running simulation holds references to the current boards — stop first.
  try {
    getToolbarActions()?.stop();
  } catch {
    /* stopping is best-effort */
  }

  const sim = useSimulatorStore.getState();

  // Boards: tear down and rebuild with the SAME ids so wires + file groups
  // (group-<id>) resolve identically.
  for (const b of [...sim.boards]) sim.removeBoard(b.id);
  for (const b of cp.boards) {
    useSimulatorStore.getState().addBoard(b.boardKind, b.x, b.y, b.id);
    if (b.languageMode && b.languageMode !== 'arduino') {
      useSimulatorStore.getState().setBoardLanguageMode(b.id, b.languageMode);
    }
    useSimulatorStore.getState().updateBoard(b.id, {
      name: b.name,
      libraries: b.libraries,
    });
  }

  // Files: board groups re-resolved AFTER language modes settled (switching
  // modes replaces the group id).
  const groups: Record<string, { name: string; content: string }[]> = {
    ...cp.otherGroups,
  };
  for (const b of useSimulatorStore.getState().boards) {
    const files = cp.boardFiles[b.id];
    if (files) groups[b.activeFileGroupId] = files;
  }
  useEditorStore.getState().replaceFileGroups(groups);

  // Canvas parts + wires
  useSimulatorStore.getState().setComponents(clone(cp.components));
  useSimulatorStore.getState().setWires(clone(cp.wires));

  if (cp.activeBoardId && useSimulatorStore.getState().boards.some((b) => b.id === cp.activeBoardId)) {
    useSimulatorStore.getState().setActiveBoardId(cp.activeBoardId);
  }

  await settle();
  if (typeof document !== 'undefined') {
    useSimulatorStore.getState().recalculateAllWirePositions();
  }
}
