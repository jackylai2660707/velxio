/**
 * Cloud projects modal: save the current workspace (create or overwrite) and
 * open / delete stored projects. Reached from the header user menu or the
 * editor's Save button (via the proSaveAction hook — see install.ts).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudStore } from './useCloudStore';
import { showConfirmDialog } from '../store/useMessageDialogStore';
import { triggerDownloadVlx } from '../utils/vlxFile';
import './cloud.css';

export function CloudProjectsModal() {
  const { t } = useTranslation();
  const open = useCloudStore((s) => s.projectsModalOpen);
  const setOpen = useCloudStore((s) => s.setProjectsModalOpen);
  const projects = useCloudStore((s) => s.projects);
  const currentId = useCloudStore((s) => s.currentCloudProjectId);
  const currentName = useCloudStore((s) => s.currentCloudProjectName);
  const saveProject = useCloudStore((s) => s.saveProject);
  const loadProject = useCloudStore((s) => s.loadProject);
  const deleteProject = useCloudStore((s) => s.deleteProject);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(currentName || '');
      setError('');
    }
  }, [open, currentName]);

  if (!open) return null;

  const doSave = async (asNew: boolean) => {
    setBusy(true);
    setError('');
    try {
      await saveProject(name.trim() || 'Untitled', asNew);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doLoad = async (id: string) => {
    const ok = await showConfirmDialog(t('cloud.loadConfirm'));
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await loadProject(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string, pname: string) => {
    const ok = await showConfirmDialog(t('cloud.deleteConfirm', { name: pname }));
    if (!ok) return;
    try {
      await deleteProject(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString();

  return (
    <div
      className="cloud-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="cloud-modal">
        <div className="cloud-modal__header">
          <span>☁️ {t('cloud.myProjects')}</span>
          <button className="cloud-modal__close" onClick={() => setOpen(false)} aria-label={t('agent.close')}>
            ✕
          </button>
        </div>
        <div className="cloud-modal__body">
          <label>
            {t('cloud.projectName')}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cloud.projectNamePlaceholder')}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="cloud-primary-btn"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void doSave(false)}
            >
              {currentId ? t('cloud.saveOverwrite') : t('cloud.saveToCloud')}
            </button>
            {currentId && (
              <button className="cloud-secondary-btn" disabled={busy} onClick={() => void doSave(true)}>
                {t('cloud.saveAsNew')}
              </button>
            )}
            <button
              className="cloud-secondary-btn"
              onClick={() => triggerDownloadVlx({ name: name.trim() || undefined })}
              title={t('cloud.downloadVlxHint')}
            >
              .vlx
            </button>
          </div>

          {error && <div className="cloud-error">{error}</div>}

          <div className="cloud-list">
            {projects.length === 0 && <div className="cloud-empty">{t('cloud.noProjects')}</div>}
            {projects.map((p) => (
              <div
                key={p.id}
                className={`cloud-list__row${p.id === currentId ? ' cloud-list__row--current' : ''}`}
              >
                <div className="cloud-list__main" onClick={() => void doLoad(p.id)}>
                  <div className="cloud-list__name">{p.name}</div>
                  <div className="cloud-list__meta">
                    {fmtDate(p.updated_at)} · {(p.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  className="cloud-list__action"
                  onClick={() => void doDelete(p.id, p.name)}
                  title={t('cloud.delete')}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
