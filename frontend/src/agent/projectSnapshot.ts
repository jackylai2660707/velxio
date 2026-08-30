/**
 * Builds the `<project_state>` block the assistant sees at the start of every
 * user turn (and via the `get_project` tool).
 *
 * The snapshot is rebuilt from the live Zustand stores each time, so the
 * model always sees the CURRENT state — including any manual edits the
 * student made to code, components, or wires since the previous turn.
 */

import { useEditorStore } from '../store/useEditorStore';
import { getEsp32Bridge, useSimulatorStore } from '../store/useSimulatorStore';
import { boardDisplayName } from '../types/board';
import { getDefaultOptionsForKind, isEsp32Family } from '../types/boardOptions';
import { getEsp32Capabilities } from './esp32Capabilities';
import { breadboardGroupKey } from '../utils/breadboardNets';

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
      if (b.name?.trim()) lines.push(`  name: ${boardDisplayName(b)}`);
      if (b.libraries?.length) lines.push(`  libraries: ${b.libraries.join(', ')}`);

      // ESP32 hardware contract and live runtime state. Keep this adjacent to
      // each board so an agent working on a multi-board project cannot confuse
      // one chip's pins/options with another's.
      if (isEsp32Family(b.boardKind)) {
        const caps = getEsp32Capabilities(b.boardKind);
        if (caps) {
          lines.push(`  esp32: family=${caps.family}, arch=${caps.architecture}`);
          lines.push(`  gpio: ${caps.gpio.length ? caps.gpio.join(', ') : 'not available in OSS runtime'}`);
          if (caps.adc.length) {
            const adc = caps.adc.map((a) => `GPIO${a.gpio}=ADC${a.unit}_CH${a.channel}`).join(', ');
            lines.push(`  adc: ${adc}`);
          } else {
            lines.push('  adc: not available in OSS runtime');
          }
          lines.push(`  adc_notes: ${caps.adcNotes.join(' ') || 'none'}`);
          lines.push(`  uart: ${caps.uart.join('; ') || 'not available in OSS runtime'}`);
          lines.push(`  i2c: ${caps.i2c}`);
          lines.push(`  spi: ${caps.spi}`);
          lines.push(`  pwm: ${caps.pwm}`);
          lines.push(
            `  wifi_capability: supported=${caps.wifi.supported}, runtime=${caps.wifi.mode}; ${caps.wifi.notes.join(' ')}`,
          );
          lines.push(
            `  ble_capability: supported=${caps.ble.supported}, gatt=${caps.ble.gatt}, classic_bluetooth=${caps.ble.classicBluetooth}; ${caps.ble.notes.join(' ')}`,
          );
          lines.push(
            `  onboard: camera=${caps.camera}, microphone=${caps.microphone}, sd=${caps.sd}`,
          );
          if (caps.notes.length) lines.push(`  hardware_notes: ${caps.notes.join(' ')}`);
        }

        const options = { ...getDefaultOptionsForKind(b.boardKind), ...(b.boardOptions ?? {}) };
        lines.push(`  board_options: ${JSON.stringify(options)}${b.boardOptions ? '' : ' (defaults)'}`);

        const bridge = getEsp32Bridge(b.id);
        lines.push(
          `  runtime: websocket=${bridge?.connected ? 'connected' : 'disconnected'}, ` +
            `running=${b.running}, has_wifi=${Boolean(b.hasWifi)}, ` +
            `wifi_status=${formatStatus(b.wifiStatus)}, ble_status=${formatStatus(b.bleStatus)}`,
        );
        if (b.wifiStatus?.inBrowser !== undefined) {
          lines.push(`  wifi_execution: ${b.wifiStatus.inBrowser ? 'browser-tab' : 'backend-qemu'}`);
        }
        if (b.spiffsFiles?.length) {
          lines.push(
            `  spiffs_files: ${b.spiffsFiles
              .map((f) => `${f.name}(${typeof f.size === 'number' ? f.size : estimateB64Bytes(f.contentB64)}B)`)
              .join(', ')}`,
          );
        } else {
          lines.push('  spiffs_files: none');
        }
        if (b.sdFiles?.length) {
          lines.push(
            `  sd_files: ${b.sdFiles
              .map((f) => `${f.name}(${estimateB64Bytes(f.contentB64)}B)`)
              .join(', ')}`,
          );
        }
      }
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
      const burnt = sim.burntComponents.has(c.id)
        ? ' [BURNT — destroyed by overcurrent; fix the circuit]'
        : '';
      const seated = sim.wires
        .filter((w) => w.bb && ((w.start.componentId === c.id) || (w.end.componentId === c.id)))
        .map((w) => {
          const hole = w.start.componentId === c.id ? w.end.pinName : w.start.pinName;
          const bbId = w.start.componentId === c.id ? w.end.componentId : w.start.componentId;
          const bbType = sim.components.find((part) => part.id === bbId)?.metadataId ?? 'breadboard';
          const group = breadboardGroupKey(bbType, hole);
          return `${hole}${group ? `(${group})` : ''}`;
        });
      const isTactileButton = c.metadataId === 'pushbutton' || c.metadataId === 'pushbutton-6mm';
      if (isTactileButton) {
        const angle = ((Number(c.properties?.rotation) || 0) % 360 + 360) % 360;
        lines.push(
          `  tactile_button: rotation=${angle}°; terminal-1=(1.l=1.r), terminal-2=(2.l=2.r); ` +
          `required breadboard layout: rotate 90°/270° and straddle centre trench; ` +
          `wire GPIO to terminal-1 and GND to terminal-2 (never same terminal)`,
        );
      }
      lines.push(`- id="${c.id}" type=${c.metadataId} at (${c.x}, ${c.y})${props}${seated.length ? ` seated=[${seated.join(', ')}]` : ''}${burnt}`);
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
          `${w.end.componentId}:${w.end.pinName} (${w.color}; ${w.bb ? 'SEATING invisible' : 'VISIBLE'}${w.autoRouted ? '; auto-routed' : ''}${w.signalType ? `; ${w.signalType}` : ''})`,
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

function formatStatus(status: { status?: string; ssid?: string; ip?: string } | undefined): string {
  if (!status) return 'not-observed';
  const details = [status.status, status.ssid && `ssid=${status.ssid}`, status.ip && `ip=${status.ip}`].filter(Boolean);
  return details.join(',');
}

function estimateB64Bytes(value: string | undefined): number {
  if (!value) return 0;
  // Base64 padding is guaranteed for files produced by the upload panel. The
  // estimate is only informational and avoids decoding potentially large data
  // into every project snapshot.
  return Math.max(0, Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
}
