import { useEffect, type ReactElement } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { BrandLandingPage } from './pages/BrandLandingPage';
import { EditorPage } from './pages/EditorPage';
import { ExamplesPage } from './pages/ExamplesPage';
// Login, Register, ForgotPassword, ResetPassword, Admin, UserProfile,
// Project, ProjectById — moved to the pro overlay in Phase 3 of the
// OSS split. They register themselves via registerProRoutes() inside
// mountPro() and appear under /login, /admin, /:username etc. only when
// the overlay is loaded.
import { LearnPage } from './pages/LearnPage';
import { LessonPage } from './pages/LessonPage';
import { TeacherPage } from './pages/TeacherPage';
import { GuidePage } from './pages/GuidePage';
import { ExampleDetailPage } from './pages/ExampleDetailPage';
import { ExampleEditorPage } from './pages/ExampleEditorPage';
import { LocaleSync } from './i18n/LocaleSync';
import { NON_DEFAULT_LOCALES } from './i18n/config';
import { useProRoutes } from './lib/proRoutes';
import { triggerSessionCheck } from './lib/proSession';
// Fork feature: self-contained cloud accounts + storage. Importing the module
// registers the session-check and save-action hooks before App mounts.
import './cloud/install';
import { MessageDialogHost } from './components/ui/MessageDialogHost';
import './App.css';

/**
 * Single source of truth for the route tree. Each entry is registered
 * twice in <Routes> below: once at the root (default locale) and once
 * nested under each non-default locale prefix (e.g. `/es/editor`).
 *
 * Index entries (path === '') belong to the locale-prefixed parent's
 * `index` slot — they render at exactly `/<locale>/`.
 */
// In Tauri desktop builds the marketing landing page is a disorienting
// first screen — users opened the desktop app to land in the editor.
// `/` redirects there. Web builds still see the LandingPage.
const ROOT_ELEMENT: ReactElement = import.meta.env.VITE_DESKTOP ? (
  <Navigate to="/editor" replace />
) : (
  <BrandLandingPage />
);

const ROUTES: { path: string; element: ReactElement; index?: boolean }[] = [
  { path: '/', element: ROOT_ELEMENT, index: true },
  { path: 'editor', element: <EditorPage /> },
  // 「AI物聯網實驗室」learning module: course list, lesson player, and the
  // teacher class-management dashboard.
  { path: 'learn', element: <LearnPage /> },
  { path: 'learn/:courseId/:lessonId', element: <LessonPage /> },
  { path: 'teacher', element: <TeacherPage /> },
  { path: 'examples', element: <ExamplesPage /> },
  // /examples/<id> = SEO landing (preview, badges, "Open in Simulator" CTA).
  // /example/<id>  = live editor with the example pre-loaded; the URL
  //                  stays pinned so links are shareable + bookmarkable.
  // Singular vs plural is intentional — Google indexes the plural landings.
  { path: 'examples/:exampleId', element: <ExampleDetailPage /> },
  { path: 'example/:exampleId', element: <ExampleEditorPage /> },
  // The product's only documentation: a non-technical user guide for
  // students and teachers. The upstream developer DocsPage and the SEO
  // marketing landing pages (circuit-simulator, v2, pricing, …) are
  // intentionally not routed — this deployment is a classroom product,
  // not the velxio.dev marketing site.
  { path: 'guide', element: <GuidePage /> },
  { path: 'docs', element: <GuidePage /> },
  { path: 'docs/:section', element: <GuidePage /> },
];

/**
 * The default locale (Traditional Chinese) is served at the root with NO
 * `/zh-tw` prefix, so `/zh-tw/...` matches no route and renders blank. People
 * reasonably guess `/zh-tw/` by analogy with `/en/`, `/zh-cn/`, … — redirect
 * them to the prefix-free path (`/zh-tw/editor` → `/editor`, `/zh-tw` → `/`)
 * instead of a blank page. This keeps the canonical no-prefix URLs while
 * handling the guessed ones gracefully.
 */
function DefaultPrefixRedirect() {
  const { pathname, search, hash } = useLocation();
  const stripped = pathname.replace(/^\/zh-tw(?=\/|$)/, '');
  return <Navigate to={(stripped || '/') + search + hash} replace />;
}

function App() {
  // Pro overlay registers extra routes (login, register, admin, profile,
  // project-by-slug, …) via registerProRoutes() inside mountPro(). The
  // subscription is sync external store, so any registration after the
  // initial render triggers a re-render — no Not-Found flash for routes
  // the overlay was about to add.
  const proRoutes = useProRoutes();
  const allRoutes = [...ROUTES, ...proRoutes];

  useEffect(() => {
    // Pro overlay's mountPro() registers a session-check callback that
    // resolves the JWT cookie into a user object. No-op in OSS without
    // the overlay.
    triggerSessionCheck();
    // #root-seo is a static SEO fallback in index.html (position:absolute,
    // visibility:hidden). It still contributes to document scrollHeight, so
    // every page got a phantom scroll the size of the prerendered SEO body.
    document.getElementById('root-seo')?.remove();
  }, []);

  return (
    <Router>
      <LocaleSync>
        <Routes>
          {/* Default locale (Traditional Chinese) — no URL prefix. */}
          {allRoutes.map((r) =>
            r.index ? (
              <Route key="root" path="/" element={r.element} />
            ) : (
              <Route key={r.path} path={`/${r.path}`} element={r.element} />
            )
          )}

          {/*
            Non-default locales — same routes nested under `/<locale>/`.
            We register one branch per locale rather than a `:lang` param
            so React Router doesn't accidentally swallow real top-level
            paths like `/circuit-simulator` as a locale segment.
          */}
          {NON_DEFAULT_LOCALES.map((locale) => (
            <Route key={`locale-${locale}`} path={`/${locale}`}>
              {allRoutes.map((r) =>
                r.index ? (
                  <Route key={`${locale}-root`} index element={r.element} />
                ) : (
                  <Route
                    key={`${locale}-${r.path}`}
                    path={r.path}
                    element={r.element}
                  />
                )
              )}
            </Route>
          ))}

          {/* `/zh-tw/...` is the default locale spelled out — redirect to the
              canonical prefix-free path instead of rendering a blank page. */}
          <Route path="/zh-tw/*" element={<DefaultPrefixRedirect />} />
        </Routes>
      </LocaleSync>
      {/* Global alert() replacement — opened from anywhere (React or plain
          .ts) via showMessageDialog() in store/useMessageDialogStore. */}
      <MessageDialogHost />
    </Router>
  );
}

export default App;
