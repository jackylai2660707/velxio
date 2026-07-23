/**
 * Compact weekly AI-token usage meter shown above the chat composer.
 * Fetches /api/auth/usage on mount and again after every finished agent
 * turn (busy true→false), so students always see where they stand against
 * their weekly quota. Hidden when signed out (anonymous users can't use
 * the server-funded key anyway).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi, type AiUsage } from '../../cloud/cloudApi';
import { useCloudStore } from '../../cloud/useCloudStore';
import { useAgentStore } from '../../store/useAgentStore';
import './AgentUsageMeter.css';

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export const AgentUsageMeter: React.FC = () => {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const busy = useAgentStore((s) => s.busy);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const prevBusy = useRef(busy);

  useEffect(() => {
    if (!user) {
      setUsage(null);
      return;
    }
    // Refresh on sign-in and whenever a turn just finished.
    const turnEnded = prevBusy.current && !busy;
    prevBusy.current = busy;
    if (usage !== null && !turnEnded) return;
    let cancelled = false;
    authApi
      .usage()
      .then((u) => !cancelled && setUsage(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, busy]);

  if (!user || !usage) return null;

  const pct = Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));
  const level = pct >= 95 ? 'danger' : pct >= 75 ? 'warn' : 'ok';

  return (
    <div
      className={`agent-usage agent-usage--${level}`}
      title={t('agent.usageTip', '每週一重置。用完後 AI 助教會暫停,需請管理員調整額度。')}
    >
      <span className="agent-usage__label">{t('agent.usageLabel', '本週 AI 用量')}</span>
      <span className="agent-usage__bar">
        <span className="agent-usage__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="agent-usage__numbers">
        {compact(usage.used)} / {compact(usage.limit)}
      </span>
    </div>
  );
};
