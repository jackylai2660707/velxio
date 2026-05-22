/**
 * Native menubar event bridge.
 *
 * The Tauri shell (pro/desktop/src-tauri/src/menu.rs in velxio-prod)
 * builds a Velxio / File / Edit / View / Help menubar. Internal items
 * (Save .vlx, Open .vlx, Toggle Serial Monitor, Find, …) emit a
 * `velxio://menu` event with `{ action: '<id>' }`. URL items (Docs,
 * Examples, Discord, GitHub) are opened directly from Rust and don't
 * reach this listener.
 *
 * Actions handled directly here (no further plumbing needed):
 *   - save-vlx, open-vlx     → triggerDownloadVlx / file picker
 *   - toggle-serial-monitor  → useSimulatorStore.toggleSerialMonitor()
 *   - check-for-updates      → tauri-plugin-updater check()
 *
 * Actions forwarded to whoever's listening as a window CustomEvent
 * `velxio:menu:<action>`:
 *   - new-project, find-in-editor, toggle-file-explorer
 *
 * No-op outside Tauri (e.g. running the bundle in a regular browser
 * for debugging) — listen() returns a no-op when the global event
 * API isn't present.
 */

import { listen } from './tauriBridge';
import { dlog } from './log';
import { triggerDownloadVlx, importVlxFile } from '../utils/vlxFile';
import { useSimulatorStore } from '../store/useSimulatorStore';

type MenuAction =
  | 'new-project'
  | 'save-vlx'
  | 'open-vlx'
  | 'find-in-editor'
  | 'toggle-file-explorer'
  | 'toggle-serial-monitor'
  | 'check-for-updates';

interface MenuEventPayload {
  action: MenuAction;
}

let installed = false;

export async function installDesktopMenuListener(): Promise<void> {
  if (installed) return;
  installed = true;
  await listen<MenuEventPayload>('velxio://menu', (event) => {
    dlog('menu event', event.payload);
    void handle(event.payload.action);
  });
}

async function handle(action: MenuAction): Promise<void> {
  switch (action) {
    case 'save-vlx':
      triggerDownloadVlx();
      return;
    case 'open-vlx':
      pickAndImportVlx();
      return;
    case 'toggle-serial-monitor':
      useSimulatorStore.getState().toggleSerialMonitor();
      return;
    case 'new-project':
    case 'find-in-editor':
    case 'toggle-file-explorer':
      window.dispatchEvent(new CustomEvent(`velxio:menu:${action}`));
      return;
    case 'check-for-updates':
      await checkForUpdates();
      return;
  }
}

function pickAndImportVlx(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.vlx,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) {
      try {
        await importVlxFile(file);
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(`Failed to open .vlx: ${(err as Error).message}`);
      }
    }
    document.body.removeChild(input);
  });
  input.click();
}

async function checkForUpdates(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updater = (window as any).__TAURI__?.updater;
    if (!updater?.check) {
      // eslint-disable-next-line no-alert
      alert('Update plugin not available in this build.');
      return;
    }
    const update = await updater.check();
    if (update) {
      await update.downloadAndInstall();
    } else {
      // eslint-disable-next-line no-alert
      alert('Velxio Desktop is up to date.');
    }
  } catch (err) {
    // eslint-disable-next-line no-alert
    alert(`Update check failed: ${(err as Error).message}`);
  }
}
