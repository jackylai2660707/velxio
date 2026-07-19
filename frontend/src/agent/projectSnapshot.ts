/**
 * Builds the `<project_state>` block the assistant sees at the start of every
 * user turn (and via the `get_project` tool).
 *
 * The snapshot is rebuilt from the live Zustand stores each time, so the
 * model always sees the CURRENT state — including any manual edits the
 * student made to code, components, or wires since the previous turn.
 */

import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 48_000;

function fenceFile(name: string, content: string): string {
  let body = content;
  if (body.length > MAX_FILE_CHARS) {
    body =
      body.slice(0, MAX_FILE_CHARS) +
      `\n… [truncated — file is ${content.length} chars; use read-focused edits]`;
  }
  return `--- file: ${name} (${content.length} chars) ---\n${body}\n`;
}

export function buildProjectSnapshot(): string {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  const lines: string[] = [];

  // ── Boards ────────────────────────────────────────────────────────────
  if (sim.boards.length === 0) {
    lines.push('BOARDS: none (empty canvas — add a board first)');
  } else {
    lines.push('BOARDS:');
    for (const b of sim.boards) {
      const flags = [
        b.id === sim.activeBoardId ? 'ACTIVE' : null,
        b.running ? 'running' : 'stopped',
        `lang=${b.languageMode}`,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- id="${b.id}" kind=${b.boardKind} at (${b.x}, ${b.y}) [${flags}]`);
      if (b.libraries?.length) lines.push(`  libraries: ${b.libraries.join(', ')}`);
    }
  }

  // ── Components (non-board) ────────────────────────────────────────────
  if (sim.components.length === 0) {
    lines.push('COMPONENTS: none');
  } else {
    lines.push('COMPONENTS:');
    for (const c of sim.components) {
      const props =
        c.properties && Object.keys(c.properties).length > 0
          ? ` props=${JSON.stringify(c.properties)}`
          : '';
      lines.push(`- id="${c.id}" type=${c.metadataId} at (${c.x}, ${c.y})${props}`);
    }
  }

  // ── Wires ─────────────────────────────────────────────────────────────
  if (sim.wires.length === 0) {
    lines.push('WIRES: none');
  } else {
    lines.push('WIRES:');
    for (const w of sim.wires) {
      lines.push(
        `- id="${w.id}" ${w.start.componentId}:${w.start.pinName} -> ` +
          `${w.end.componentId}:${w.end.pinName} (${w.color})`,
      );
    }
  }

  // ── Files, grouped per board ──────────────────────────────────────────
  let budget = MAX_TOTAL_CHARS;
  lines.push('FILES:');
  const emitGroup = (label: string, groupId: string) => {
    const files = editor.getGroupFiles(groupId);
    if (files.length === 0) return;
    lines.push(`# ${label}`);
    for (const f of files) {
      if (budget <= 0) {
        lines.push(`--- file: ${f.name} (${f.content.length} chars) [omitted — snapshot budget exhausted; keep files small] ---`);
        continue;
      }
      const block = fenceFile(f.name, f.content);
      budget -= block.length;
      lines.push(block);
    }
  };

  const boardGroupIds = new Set<string>();
  for (const b of sim.boards) {
    boardGroupIds.add(b.activeFileGroupId);
    emitGroup(`board "${b.id}"`, b.activeFileGroupId);
  }
  // Non-board groups (custom-chip programs etc.)
  for (const gid of Object.keys(editor.fileGroups)) {
    if (!boardGroupIds.has(gid)) emitGroup(`group "${gid}"`, gid);
  }

  return lines.join('\n');
}
