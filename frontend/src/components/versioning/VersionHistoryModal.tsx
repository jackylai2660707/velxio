/**
 * Version History modal — git-style linear project versions for students.
 *
 * Opened from the clock icon in the FileExplorer header. Lists snapshots
 * (manual saves, automatic per-AI-turn versions, pre-restore backups) with
 * restore / rename / delete, plus a "save current version" composer.
 * Rendered to document.body via portal (same pattern as ShareModal — the
 * sidebar's overflow/stacking context would clip it otherwise).
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVersionStore } from '../../versioning/useVersionStore';
import type { VersionMeta } from '../../versioning/versionDb';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import './VersionHistoryModal.css';

const SOURCE_ICON: Record<VersionMeta['source'], string> = {
  manual: '🖐',
  ai: '✨',
  auto: '⟳',
};

function relativeTime(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (min < 1) return rtf.format(0, 'minute');
  if (min < 60) return rtf.format(-min, 'minute');
  const hours = Math.round(min / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

export const VersionHistoryModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t, i18n } = useTranslation();
  const { versions, loaded, busy, refresh, saveVersion, restoreVersion, deleteVersion, renameVersion } =
    useVersionStore();
  const [saveLabel, setSaveLabel] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSave = async () => {
    const meta = await saveVersion(saveLabel || t('versions.defaultLabel'), 'manual');
    setSaveLabel('');
    setNotice(meta ? t('versions.saved', { label: meta.label }) : t('versions.unchanged'));
  };

  const handleRestore = async (v: VersionMeta) => {
    const ok = await showConfirmDialog(t('versions.restoreConfirm', { label: v.label }));
    if (!ok) return;
    const done = await restoreVersion(v.id);
    setNotice(done ? t('versions.restored', { label: v.label }) : t('versions.restoreFailed'));
    if (done) void refresh(); // the pre-restore backup appears in the list
  };

  const handleDelete = async (v: VersionMeta) => {
    const ok = await showConfirmDialog(t('versions.deleteConfirm', { label: v.label }));
    if (ok) await deleteVersion(v.id);
  };

  const commitRename = async () => {
    if (renamingId && renameDraft.trim()) await renameVersion(renamingId, renameDraft);
    setRenamingId(null);
  };

  return createPortal(
    <div className="version-modal-overlay" onClick={onClose}>
      <div className="version-modal" onClick={(e) => e.stopPropagation()}>
        <div className="version-modal__header">
          <span>🕘 {t('versions.title')}</span>
          <button className="version-modal__close" onClick={onClose} aria-label={t('agent.close')}>
            ✕
          </button>
        </div>

        <div className="version-modal__composer">
          <input
            type="text"
            value={saveLabel}
            placeholder={t('versions.savePlaceholder')}
            maxLength={60}
            onChange={(e) => setSaveLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave();
            }}
          />
          <button onClick={() => void handleSave()} disabled={busy}>
            {t('versions.saveNow')}
          </button>
        </div>

        {notice && <div className="version-modal__notice">{notice}</div>}

        <div className="version-modal__list">
          {!loaded && <div className="version-modal__empty">…</div>}
          {loaded && versions.length === 0 && (
            <div className="version-modal__empty">{t('versions.empty')}</div>
          )}
          {versions.map((v) => (
            <div key={v.id} className="version-modal__row">
              <span className="version-modal__source" title={t(`versions.source.${v.source}`)}>
                {SOURCE_ICON[v.source]}
              </span>
              <div className="version-modal__main">
                {renamingId === v.id ? (
                  <input
                    className="version-modal__rename"
                    autoFocus
                    value={renameDraft}
                    maxLength={60}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <div
                    className="version-modal__label"
                    title={t('versions.renameHint')}
                    onDoubleClick={() => {
                      setRenamingId(v.id);
                      setRenameDraft(v.label);
                    }}
                  >
                    {v.label}
                  </div>
                )}
                <div className="version-modal__meta">
                  {relativeTime(v.createdAt, i18n.language)} ·{' '}
                  {t('versions.stats', {
                    boards: v.stats.boards,
                    components: v.stats.components,
                    files: v.stats.files,
                  })}
                </div>
              </div>
              <button
                className="version-modal__action version-modal__action--restore"
                onClick={() => void handleRestore(v)}
                disabled={busy}
              >
                {t('versions.restore')}
              </button>
              <button
                className="version-modal__action"
                onClick={() => void handleDelete(v)}
                disabled={busy}
                title={t('versions.delete')}
                aria-label={t('versions.delete')}
              >
                🗑
              </button>
            </div>
          ))}
        </div>

        <div className="version-modal__hint">{t('versions.hint')}</div>
      </div>
    </div>,
    document.body,
  );
};
