/**
 * Velxio Desktop SPA hooks — mounted from main.tsx when VITE_DESKTOP is set.
 *
 * Two responsibilities in Phase 3:
 *
 *  1. Show the welcome / sign-in screen if the stored license key
 *     fails validation. While the welcome screen is up, the SPA's
 *     editor is hidden behind it so the user can't compile / run.
 *  2. Mount desktop-only side panels (the ESP32 QEMU prompt).
 *
 * Phase 4 will add the offline JWT cache and grace banners on top.
 *
 * Pure OSS still runs without any of this (the dynamic import is
 * tree-shaken when the env flag is unset). The pro overlay also
 * doesn't load in desktop builds, so this module owns the desktop UI.
 */

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { createElement as h, Fragment } from 'react';
import { DesktopWelcomePage } from './DesktopWelcomePage';
import { Esp32QemuPrompt } from './Esp32QemuPrompt';
import { GraceBanner } from './GraceBanner';
import { invoke, isTauri, type ValidationResult } from './tauriBridge';
import { installDesktopMenuListener } from './menu';
import { dlog } from './log';
import './desktop.css';

let mounted = false;
let welcomeRoot: Root | null = null;
let welcomeHost: HTMLElement | null = null;
let sidePanelRoot: Root | null = null;

function unmountWelcome(): void {
  if (welcomeRoot) {
    try { welcomeRoot.unmount(); } catch { /* noop */ }
    welcomeRoot = null;
  }
  if (welcomeHost) {
    welcomeHost.remove();
    welcomeHost = null;
  }
}

function mountWelcome(): void {
  if (welcomeRoot) return;
  welcomeHost = document.createElement('div');
  welcomeHost.id = 'velxio-desktop-welcome-root';
  document.body.appendChild(welcomeHost);
  welcomeRoot = createRoot(welcomeHost);
  welcomeRoot.render(
    createElement(DesktopWelcomePage, {
      onAuthorised: () => unmountWelcome(),
    }),
  );
}

function mountSidePanels(): void {
  if (sidePanelRoot) return;
  const host = document.createElement('div');
  host.id = 'velxio-desktop-side-panels';
  document.body.appendChild(host);
  sidePanelRoot = createRoot(host);
  // Single root for both side-panel surfaces so we don't burn extra
  // React roots on the document. Both renderers return null when
  // they have nothing to show, so the only cost is the subscription
  // they each install.
  sidePanelRoot.render(
    h(Fragment, null, h(GraceBanner, null), h(Esp32QemuPrompt, null)),
  );
}

/**
 * Resolve the initial license state without blocking the SPA's mount.
 * If there's no key OR the key doesn't authorise desktop, mount the
 * welcome screen on top. Otherwise stay invisible — the editor takes
 * over the window.
 */
async function checkInitialLicense(): Promise<void> {
  if (!isTauri()) {
    // Running outside Tauri (e.g. `vite dev` in a regular browser tab).
    // Skip the welcome screen so the SPA is debuggable.
    return;
  }
  try {
    const key = await invoke<string | null>('license_get_key');
    if (!key) {
      mountWelcome();
      return;
    }
    const result = await invoke<ValidationResult>('license_validate', { key });
    if (!result.valid || !result.entitlements?.desktop) {
      mountWelcome();
    }
  } catch (err) {
    // Network / keychain error — show welcome with the error message
    // surfaced via the onAuthorised contract.
    console.warn('[desktop] initial license check failed:', err);
    mountWelcome();
  }
}

export const mountDesktop = (): void => {
  if (mounted) return;
  mounted = true;
  dlog('mountDesktop — Tauri shell active');

  // Native menubar (Velxio / File / Edit / View / Help) sends events
  // here. Hook the listener before any UI is mounted so the first
  // user click is never dropped.
  void installDesktopMenuListener();

  mountSidePanels();
  void checkInitialLicense();
};
