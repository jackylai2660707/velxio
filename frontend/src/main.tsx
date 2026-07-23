import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import './index.css';
// Side-effect import: initialises i18next BEFORE any component renders so
// useTranslation() always resolves against a live instance. Must come
// before App.
import './i18n';
// Side-effect import: registers EVERY custom element (upstream wokwi +
// velxio-local) exactly once. Do NOT import individual element modules here —
// add new elements to elements-register.ts instead, so the app runtime and
// the tests/metadata-generator can never drift apart (a component that is
// only registered in one place renders 0×0 with no pinInfo in the other).
import './elements-register';
import App from './App.tsx';

// Configure monaco-editor for offline use via local static assets
const monacoVsPath = `${import.meta.env.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoVsPath } });

createRoot(document.getElementById('root')!).render(<App />);

// Tear down the Tauri-only splash now that React has mounted. Wait
// two animation frames so React's first paint commits before we
// touch the splash — otherwise users see a black flash between the
// splash fading and the editor first appearing. Fade via CSS
// transition for a smoother handoff, then remove the node entirely
// once the transition finishes.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('velxio-splash');
    if (!splash) return;
    splash.style.transition = 'opacity 250ms ease-out';
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    window.setTimeout(() => splash.remove(), 320);
  });
});

// Optional pro overlay. The `@pro` import resolves to a no-op stub in the
// open-source build (see vite.config.ts) and to the real overlay only when
// VITE_PRO_BUILD=true at build time. The dynamic import keeps the pro chunk
// out of the OSS bundle entirely (Vite tree-shakes the never-taken branch).
//
// Two desktop modes since v0.4.0:
//   - VITE_PRO_BUILD + VITE_DESKTOP → slim pro entry (@pro/desktop_index)
//     that ONLY mounts the AI agent + DiagnoseCompileButton, no analytics
//     / sessions / billing / admin / save overrides (those talk to
//     velxio.dev with cookies the desktop doesn't have).
//   - VITE_PRO_BUILD only (web) → full mountPro with every surface.
// VITE_DESKTOP alone (no pro) stays a pure-OSS desktop build.
if (import.meta.env.VITE_PRO_BUILD) {
  if (import.meta.env.VITE_DESKTOP) {
    import('@pro/desktop_index')
      .then((m) => m.mountProDesktop?.())
      .catch((err) => console.warn('[pro-desktop] failed to load slim overlay:', err));
  } else {
    import('@pro/index')
      .then((m) => m.mountPro?.())
      .catch((err) => console.warn('[pro] failed to load overlay:', err));
  }
}

// Desktop-only hooks (ESP32 QEMU prompt now, welcome screen in Phase 3).
// Dynamic import so the OSS bundle never pulls this in.
if (import.meta.env.VITE_DESKTOP) {
  import('./desktop/index')
    .then((m) => m.mountDesktop?.())
    .catch((err) => console.warn('[desktop] failed to load hooks:', err));
}
