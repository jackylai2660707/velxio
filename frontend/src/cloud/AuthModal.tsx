/**
 * Sign-in / sign-up modal for the fork's self-contained cloud.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudStore } from './useCloudStore';
import './cloud.css';

export function AuthModal() {
  const { t } = useTranslation();
  const open = useCloudStore((s) => s.authModalOpen);
  const setOpen = useCloudStore((s) => s.setAuthModalOpen);
  const login = useCloudStore((s) => s.login);
  const register = useCloudStore((s) => s.register);
  const authBusy = useCloudStore((s) => s.authBusy);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  const submit = async () => {
    setError('');
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), password, name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canSubmit = !authBusy && email.trim().length > 3 && password.length >= 6;

  return (
    <div className="cloud-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cloud-modal">
        <div className="cloud-modal__header">
          <span>☁️ {mode === 'login' ? t('cloud.signIn') : t('cloud.signUp')}</span>
          <button className="cloud-modal__close" onClick={() => setOpen(false)} aria-label={t('agent.close')}>
            ✕
          </button>
        </div>
        <div className="cloud-modal__body">
          <div className="cloud-tabs">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              {t('cloud.signIn')}
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => setMode('register')}
            >
              {t('cloud.signUp')}
            </button>
          </div>

          {mode === 'register' && (
            <label>
              {t('cloud.name')}
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('cloud.namePlaceholder')}
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            {t('cloud.email')}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          <label>
            {t('cloud.password')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('cloud.passwordPlaceholder')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void submit();
              }}
            />
          </label>

          {error && <div className="cloud-error">{error}</div>}

          <button className="cloud-primary-btn" disabled={!canSubmit} onClick={() => void submit()}>
            {authBusy
              ? t('cloud.working')
              : mode === 'login'
                ? t('cloud.signIn')
                : t('cloud.createAccount')}
          </button>
          <div style={{ fontSize: 11, color: '#7d7d7d', lineHeight: 1.5 }}>
            {t('cloud.selfHostNote')}
          </div>
        </div>
      </div>
    </div>
  );
}
