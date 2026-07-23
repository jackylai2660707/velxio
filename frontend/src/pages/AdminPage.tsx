/**
 * 管理後台 — platform-operator dashboard (role 'admin', bootstrapped from
 * VELXIO_ADMIN_EMAIL/PASSWORD on the server; no self-service path).
 *
 * Sections: overview stats → batch account creation (credentials shown
 * once, CSV download) → user table with per-user weekly AI-token usage,
 * editable quota, password reset, delete.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { useCloudStore } from '../cloud/useCloudStore';
import {
  adminApi,
  type AdminUserRow,
  type AdminBatchResult,
  type PlatformSettings,
} from '../cloud/cloudApi';
import './AdminPage.css';

/** 平台設定卡 — every operational knob, editable at runtime. */
const SettingsCard: React.FC = () => {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [draft, setDraft] = useState<PlatformSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    adminApi
      .getSettings()
      .then((s) => {
        setSettings(s);
        setDraft(s);
      })
      .catch(() => {});
  }, []);

  if (!draft || !settings) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await adminApi.putSettings(draft);
      setSettings(next);
      setDraft(next);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <section className="admin-card">
      <h2>平台設定</h2>
      <p className="admin-hint">
        即時生效,影響所有使用者。模型與額度是你的成本閥門 — 換模型前建議先用自己的帳號在編輯器試一輪。
      </p>
      <div className="admin-batch-grid">
        <label>AI 模型
          <input
            list="admin-model-suggestions"
            value={draft.ai_model}
            onChange={(e) => set('ai_model', e.target.value)}
            spellCheck={false}
          />
          <datalist id="admin-model-suggestions">
            <option value="gpt-5.6-luna" />
            <option value="gpt-5.6-terra" />
            <option value="gpt-5.6-sol" />
          </datalist>
        </label>
        <label>推理強度
          <select value={draft.ai_effort} onChange={(e) => set('ai_effort', e.target.value as PlatformSettings['ai_effort'])}>
            <option value="low">low(快、省)</option>
            <option value="medium">medium</option>
            <option value="high">high(最聰明)</option>
          </select>
        </label>
        <label>學生每週 token 額度
          <input type="number" min={0} value={draft.student_weekly_tokens}
            onChange={(e) => set('student_weekly_tokens', Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>教師每週 token 額度
          <input type="number" min={0} value={draft.teacher_weekly_tokens}
            onChange={(e) => set('teacher_weekly_tokens', Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>教師註冊碼(留白=不限制)
          <input value={draft.teacher_code} onChange={(e) => set('teacher_code', e.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="admin-toggles">
        <label className="admin-toggle">
          <input type="checkbox" checked={draft.allow_registration}
            onChange={(e) => set('allow_registration', e.target.checked)} />
          開放自助註冊(關閉後只有你發的帳號能登入)
        </label>
        <label className="admin-toggle">
          <input type="checkbox" checked={draft.allow_custom_model}
            onChange={(e) => set('allow_custom_model', e.target.checked)} />
          允許使用者自選模型/強度(關閉=全平台統一用上面的設定)
        </label>
        <label className="admin-toggle">
          <input type="checkbox" checked={draft.allow_own_key}
            onChange={(e) => set('allow_own_key', e.target.checked)} />
          允許自帶 API Key(自帶者不計量、自行付費)
        </label>
      </div>
      <div className="admin-settings-actions">
        <button className="admin-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? '儲存中…' : '儲存設定'}
        </button>
        {savedAt && <span className="admin-saved">✓ 已生效</span>}
        {dirty && !savedAt && <span className="admin-dirty">有未儲存的變更</span>}
      </div>
    </section>
  );
};

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const ROLE_LABEL: Record<string, string> = { student: '學生', teacher: '教師', admin: '管理員' };

export const AdminPage: React.FC = () => {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const sessionStatus = useCloudStore((s) => s.sessionStatus);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);

  const [overview, setOverview] = useState<Awaited<ReturnType<typeof adminApi.overview>> | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [query, setQuery] = useState('');
  const [batch, setBatch] = useState({
    role: 'student' as 'student' | 'teacher',
    count: 30,
    prefix: 'stu',
    domain: 'school.local',
    name_prefix: '學生',
    start_number: 1,
    class_code: '',
    weekly_token_limit: '' as string,
  });
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<AdminBatchResult | null>(null);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [resetShown, setResetShown] = useState<Record<string, string>>({});

  const isAdmin = user?.role === 'admin';

  useSEO({ title: '管理後台 — AI物聯網實驗室', description: '' });

  const refresh = useCallback(async (q = '') => {
    const [ov, ul] = await Promise.all([adminApi.overview(), adminApi.listUsers(q)]);
    setOverview(ov);
    setUsers(ul.users);
  }, []);

  useEffect(() => {
    if (isAdmin) void refresh().catch(() => {});
  }, [isAdmin, refresh]);

  const runBatch = async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      const res = await adminApi.batchCreate({
        role: batch.role,
        count: Math.max(1, Math.min(200, Number(batch.count) || 1)),
        prefix: batch.prefix.trim() || 'stu',
        domain: batch.domain.trim() || 'school.local',
        name_prefix: batch.name_prefix || '學生',
        start_number: Math.max(1, Number(batch.start_number) || 1),
        class_code: batch.class_code.trim(),
        weekly_token_limit:
          batch.weekly_token_limit.trim() === '' ? null : Number(batch.weekly_token_limit),
      });
      setBatchResult(res);
      await refresh(query);
    } finally {
      setBatchBusy(false);
    }
  };

  const downloadCsv = () => {
    if (!batchResult) return;
    const rows = [
      ['email', 'password', 'name'],
      ...batchResult.created.map((c) => [c.email, c.password, c.name]),
    ];
    const csv = '﻿' + rows.map((r) => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `accounts-${batch.prefix}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const saveQuota = async (u: AdminUserRow) => {
    const draft = (quotaDrafts[u.id] ?? '').trim();
    const limit = draft === '' ? null : Math.max(0, Number(draft) || 0);
    await adminApi.setQuota(u.id, limit).catch(() => {});
    setQuotaDrafts((d) => {
      const next = { ...d };
      delete next[u.id];
      return next;
    });
    await refresh(query);
  };

  const resetPassword = async (u: AdminUserRow) => {
    if (!window.confirm(`重設「${u.name}」(${u.email})的密碼?舊密碼將立即失效。`)) return;
    const r = await adminApi.resetPassword(u.id);
    setResetShown((s) => ({ ...s, [u.id]: r.password }));
  };

  const removeUser = async (u: AdminUserRow) => {
    if (!window.confirm(`確定刪除「${u.name}」(${u.email})?其專案、進度與成績將一併刪除,無法復原。`)) return;
    await adminApi.deleteUser(u.id).catch(() => {});
    await refresh(query);
  };

  if (sessionStatus !== 'signed-in') {
    return (
      <div className="admin-page">
        <AppHeader />
        <div className="admin-gate">
          <h1>{t('admin.title', '管理後台')}</h1>
          <p>{t('admin.needSignin', '請以管理員帳號登入。')}</p>
          <button className="admin-primary" onClick={() => setAuthModalOpen(true)}>
            {t('learn.signinCta', '登入 / 註冊')}
          </button>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="admin-page">
        <AppHeader />
        <div className="admin-gate">
          <h1>{t('admin.title', '管理後台')}</h1>
          <p>{t('admin.needAdmin', '這個頁面僅限平台管理員使用。')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <AppHeader />
      <div className="admin-container">
        <h1>{t('admin.title', '管理後台')}</h1>

        {/* ── Overview ─────────────────────────────────── */}
        {overview && (
          <div className="admin-stats">
            <div><strong>{overview.users.student ?? 0}</strong><span>學生</span></div>
            <div><strong>{overview.users.teacher ?? 0}</strong><span>教師</span></div>
            <div><strong>{overview.classes}</strong><span>班級</span></div>
            <div><strong>{fmt(overview.week_tokens)}</strong><span>本週 AI tokens</span></div>
            <div><strong>{fmt(overview.default_weekly_limit)}</strong><span>學生預設額度/週</span></div>
            <div><strong>{fmt(overview.teacher_weekly_limit)}</strong><span>教師預設額度/週</span></div>
          </div>
        )}

        {/* ── Platform settings ────────────────────────── */}
        <SettingsCard />

        {/* ── Batch creation ───────────────────────────── */}
        <section className="admin-card">
          <h2>批量建立帳號</h2>
          <p className="admin-hint">
            帳號為「前綴+編號@網域」,密碼自動產生 —— 建立結果只會顯示這一次,請立即下載 CSV 發給客戶。
          </p>
          <div className="admin-batch-grid">
            <label>身分
              <select value={batch.role} onChange={(e) => setBatch({ ...batch, role: e.target.value as 'student' | 'teacher' })}>
                <option value="student">學生</option>
                <option value="teacher">教師</option>
              </select>
            </label>
            <label>數量
              <input type="number" min={1} max={200} value={batch.count}
                onChange={(e) => setBatch({ ...batch, count: Number(e.target.value) })} />
            </label>
            <label>帳號前綴
              <input value={batch.prefix} onChange={(e) => setBatch({ ...batch, prefix: e.target.value })} />
            </label>
            <label>網域
              <input value={batch.domain} onChange={(e) => setBatch({ ...batch, domain: e.target.value })} />
            </label>
            <label>名稱前綴
              <input value={batch.name_prefix} onChange={(e) => setBatch({ ...batch, name_prefix: e.target.value })} />
            </label>
            <label>起始編號
              <input type="number" min={1} value={batch.start_number}
                onChange={(e) => setBatch({ ...batch, start_number: Number(e.target.value) })} />
            </label>
            {batch.role === 'student' && (
              <label>自動加入班級(代碼,選填)
                <input value={batch.class_code} placeholder="例如 9GJSQ7"
                  onChange={(e) => setBatch({ ...batch, class_code: e.target.value.toUpperCase() })} />
              </label>
            )}
            <label>每週 token 額度(留白=預設)
              <input type="number" min={0} value={batch.weekly_token_limit} placeholder={overview ? String(overview.default_weekly_limit) : ''}
                onChange={(e) => setBatch({ ...batch, weekly_token_limit: e.target.value })} />
            </label>
          </div>
          <button className="admin-primary" onClick={runBatch} disabled={batchBusy}>
            {batchBusy ? '建立中…' : `建立 ${batch.count} 個帳號`}
          </button>

          {batchResult && (
            <div className="admin-batch-result">
              <div className="admin-batch-result-head">
                <span>
                  已建立 {batchResult.created.length} 個
                  {batchResult.joined_class > 0 && `,${batchResult.joined_class} 個已入班`}
                  {batchResult.skipped.length > 0 && `;${batchResult.skipped.length} 個已存在略過`}
                </span>
                <button onClick={downloadCsv}>⬇ 下載 CSV</button>
              </div>
              <div className="admin-table-scroll admin-batch-table">
                <table>
                  <thead><tr><th>帳號</th><th>密碼</th><th>名稱</th></tr></thead>
                  <tbody>
                    {batchResult.created.map((c) => (
                      <tr key={c.email}>
                        <td>{c.email}</td>
                        <td className="admin-mono">{c.password}</td>
                        <td>{c.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* ── Users ────────────────────────────────────── */}
        <section className="admin-card">
          <div className="admin-users-head">
            <h2>帳號管理</h2>
            <input
              className="admin-search"
              value={query}
              placeholder="搜尋 email 或名稱…"
              onChange={(e) => {
                setQuery(e.target.value);
                void refresh(e.target.value).catch(() => {});
              }}
            />
          </div>
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>帳號</th><th>名稱</th><th>身分</th>
                  <th>本週用量</th><th>週額度</th><th>額度設定</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const pct = Math.min(100, Math.round((u.used_this_week / Math.max(1, u.effective_limit)) * 100));
                  return (
                    <tr key={u.id}>
                      <td className="admin-mono">{u.email}</td>
                      <td>{u.name}</td>
                      <td><span className={`admin-role admin-role-${u.role}`}>{ROLE_LABEL[u.role] ?? u.role}</span></td>
                      <td>
                        <div className="admin-usage-cell">
                          <span className="admin-usage-bar"><i style={{ width: `${pct}%` }} className={pct >= 95 ? 'danger' : pct >= 75 ? 'warn' : ''} /></span>
                          <span className="admin-mono">{fmt(u.used_this_week)}</span>
                        </div>
                      </td>
                      <td className="admin-mono">
                        {fmt(u.effective_limit)}
                        {u.weekly_token_limit === null && <span className="admin-default-tag">預設</span>}
                      </td>
                      <td>
                        <div className="admin-quota-edit">
                          <input
                            type="number"
                            min={0}
                            placeholder="留白=預設"
                            value={quotaDrafts[u.id] ?? (u.weekly_token_limit === null ? '' : String(u.weekly_token_limit))}
                            onChange={(e) => setQuotaDrafts((d) => ({ ...d, [u.id]: e.target.value }))}
                          />
                          <button onClick={() => void saveQuota(u)}>儲存</button>
                        </div>
                      </td>
                      <td>
                        <div className="admin-actions">
                          <button onClick={() => void resetPassword(u)}>重設密碼</button>
                          {u.role !== 'admin' && (
                            <button className="admin-danger" onClick={() => void removeUser(u)}>刪除</button>
                          )}
                        </div>
                        {resetShown[u.id] && (
                          <div className="admin-newpw">
                            新密碼:<span className="admin-mono">{resetShown[u.id]}</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};
