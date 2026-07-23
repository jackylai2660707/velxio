import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/useProjectStore';
import { ShareModal } from './ShareModal';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useLocalizedHref } from '../../i18n/useLocalizedNavigate';
import type { AutoSaveState } from '../../hooks/useAutoSaveProject';
import { CloudHeaderAuth } from '../../cloud/CloudHeaderAuth';
import { useCloudStore } from '../../cloud/useCloudStore';
import './LanguageSwitcher.css';


interface AppHeaderProps {
  /** Optional auto-save state — when set, renders a save status indicator. */
  autoSave?: AutoSaveState;
}

const SAVE_STATUS_COPY: Record<AutoSaveState['status'], { label: string; color: string }> = {
  idle: { label: 'Saved', color: '#7d8590' },
  dirty: { label: 'Unsaved changes', color: '#f0883e' },
  saving: { label: 'Saving…', color: '#3fb950' },
  saved: { label: 'Saved', color: '#3fb950' },
  error: { label: 'Save failed', color: '#f85149' },
};

const AutoSaveIndicator: React.FC<{ state: AutoSaveState }> = ({ state }) => {
  const meta = SAVE_STATUS_COPY[state.status];
  const tip =
    state.status === 'error' && state.errorMessage
      ? `Auto-save failed: ${state.errorMessage}`
      : state.lastSavedAt
        ? `Last saved ${new Date(state.lastSavedAt).toLocaleTimeString()}`
        : 'Auto-save ready';
  return (
    <div
      title={tip}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        color: meta.color,
        userSelect: 'none',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: meta.color,
          opacity: state.status === 'saving' ? 0.7 : 1,
          animation: state.status === 'saving' ? 'velxio-pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      <span>{meta.label}</span>
    </div>
  );
};

export const AppHeader: React.FC<AppHeaderProps> = ({ autoSave }) => {
  const location = useLocation();
  const currentProject = useProjectStore((s) => s.currentProject);
  const cloudUser = useCloudStore((s) => s.user);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const { t } = useTranslation();
  const localize = useLocalizedHref();

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Tauri desktop: skip the header entirely. The marketing nav was
  // already hidden, but the strip itself was still painting an empty
  // black bar over the editor. Brand/auto-save/share/auth-slot all
  // live elsewhere in desktop: title bar shows "Velxio Desktop", the
  // native menubar has File/Edit/View/Help, auto-save is a Pro cloud
  // feature (desktop saves to .vlx), share generates a velxio.dev URL
  // that doesn't apply to a desktop session, and the license flow
  // owns its own DesktopWelcomePage.
  if (import.meta.env.VITE_DESKTOP) {
    return null;
  }

  const isActive = (path: string) =>
    location.pathname === localize(path) ? ' header-nav-link-active' : '';

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-left">
          {/* Brand */}
          <div className="header-brand">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#0071e3"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
            </svg>
            <Link to={localize('/')} style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="header-title">{t('brand.name', 'AI物聯網實驗室')}</span>
            </Link>
          </div>

          {/* Main nav links (web only). The Tauri desktop build hides
              this nav and surfaces the equivalent actions via the
              native menubar (see pro/desktop/src-tauri/src/menu.rs in
              velxio-prod). VITE_DESKTOP is the env flag the Tauri
              build sets — main.tsx already uses it to gate the @pro
              overlay, same pattern here. */}
          {!import.meta.env.VITE_DESKTOP && (
          <nav className={'header-nav-links' + (menuOpen ? ' header-nav-open' : '')}>
            <Link to={localize('/')} className={'header-nav-link' + isActive('/')}>
              {t('header.nav.home')}
            </Link>
            <Link to={localize('/learn')} className={'header-nav-link' + isActive('/learn')}>
              {t('header.nav.learn', '課程')}
            </Link>
            <Link to={localize('/examples')} className={'header-nav-link' + isActive('/examples')}>
              {t('header.nav.examples')}
            </Link>
            <Link to={localize('/editor')} className={'header-nav-link' + isActive('/editor')}>
              {t('header.nav.editor')}
            </Link>
            <Link to={localize('/guide')} className={'header-nav-link' + isActive('/guide')}>
              {t('header.nav.guide', '使用說明')}
            </Link>
            {cloudUser?.role === 'teacher' && (
              <Link to={localize('/teacher')} className={'header-nav-link' + isActive('/teacher')}>
                {t('header.nav.teacher', '教學管理')}
              </Link>
            )}
          </nav>
          )}
        </div>

        {/* Right: language + share + auth + mobile hamburger */}
        <div className="header-right">
          <LanguageSwitcher />

          {/* Auto-save status — only when a project is loaded and the editor
              page mounted the hook */}
          {autoSave && currentProject && <AutoSaveIndicator state={autoSave} />}

          {/* Share button — visible when a project is loaded */}
          {currentProject && location.pathname === '/editor' && (
            <button
              onClick={() => setShowShareModal(true)}
              style={{
                background: 'transparent',
                border: '1px solid #555',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: '#ccc',
                fontSize: 13,
              }}
              title="Share project"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Share
            </button>
          )}

          {/* Auth UI lives in the pro overlay — sign-in/sign-up buttons
              when anonymous, user dropdown when logged in. The overlay's
              mountPro() portals its HeaderAuth component into this slot
              via mountIntoSlot('header-auth'). In OSS without the
              overlay this slot stays empty, which is correct because the
              OSS image has no auth backend either. */}
          <div data-velxio-slot="header-auth" style={{ display: 'contents' }}>
            {/* Fork feature: self-contained cloud accounts (sign-in chip +
                auth/projects modals). The pro overlay, when present, portals
                its own widget into this slot alongside. */}
            <CloudHeaderAuth />
          </div>

          {/* Mobile hamburger — useless in desktop where the nav it
              would expand is itself hidden. */}
          {!import.meta.env.VITE_DESKTOP && (
            <button
              className="header-hamburger"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              <span />
              <span />
              <span />
            </button>
          )}
        </div>
      </div>

      {showShareModal && <ShareModal onClose={() => setShowShareModal(false)} />}
    </header>
  );
};
