/**
 * Header account UI + the cloud modals (auth, projects). Rendered inside
 * AppHeader's `header-auth` slot — the same spot the velxio.dev pro overlay
 * portals its own auth widget into.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudStore } from './useCloudStore';
import { AuthModal } from './AuthModal';
import { CloudProjectsModal } from './CloudProjectsModal';
import './cloud.css';

export function CloudHeaderAuth() {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);
  const setProjectsModalOpen = useCloudStore((s) => s.setProjectsModalOpen);
  const logout = useCloudStore((s) => s.logout);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div className="cloud-header" ref={menuRef}>
      {user ? (
        <>
          <button
            className="cloud-user-chip"
            onClick={() => setMenuOpen((v) => !v)}
            title={user.email}
          >
            <span className="cloud-user-chip__avatar">
              {(user.name || user.email)[0]?.toUpperCase()}
            </span>
            {user.name || user.email}
          </button>
          {menuOpen && (
            <div className="cloud-user-menu">
              <div className="cloud-user-menu__email">{user.email}</div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setProjectsModalOpen(true);
                }}
              >
                {t('cloud.myProjects')}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  logout();
                }}
              >
                {t('cloud.signOut')}
              </button>
            </div>
          )}
        </>
      ) : (
        <button className="cloud-login-btn" onClick={() => setAuthModalOpen(true)}>
          {t('cloud.signIn')}
        </button>
      )}

      <AuthModal />
      <CloudProjectsModal />
    </div>
  );
}
