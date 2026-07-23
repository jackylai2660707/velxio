/**
 * AI assistant chat panel — right-DOCKED pane on desktop (flex child of
 * .app-container, so the canvas shrinks and nothing is overlapped),
 * fullscreen sheet on mobile. Opened from the toolbar / mobile tab bar via
 * useAgentStore.togglePanel().
 *
 * OpenAI-compatible endpoints only; base URL / key / model / effort are
 * configured in the settings view (gear). Strings are i18n'd (en + zh-cn;
 * other locales fall back to English). See docs/wiki/ai-assistant.md.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Trans, useTranslation } from 'react-i18next';
import { useAgentStore, needsApiKey, effectiveModel } from '../../store/useAgentStore';
import { useCloudStore } from '../../cloud/useCloudStore';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import type { UiMessage, UiSegment } from '../../agent/types';
import { AgentUsageMeter } from './AgentUsageMeter';
import './AgentChatPanel.css';

const SUGGESTIONS_ZH: Array<{ icon: string; text: string }> = [
  { icon: '🚦', text: '搭一个红绿灯:红黄绿三个 LED 轮流亮' },
  { icon: '📏', text: '用 HC-SR04 超声波传感器测距,把距离打印到串口' },
  { icon: '🔘', text: '加一个按钮,按下时点亮 LED' },
  { icon: '🎚️', text: '用电位器控制 LED 亮度(PWM 呼吸灯)' },
  { icon: '❓', text: '为什么 LED 必须串联一个电阻?' },
  { icon: '📚', text: '什么是 PWM?在我的电路里演示一下' },
];
const SUGGESTIONS_EN: Array<{ icon: string; text: string }> = [
  { icon: '🚦', text: 'Build a traffic light with red, yellow and green LEDs' },
  { icon: '📏', text: 'Measure distance with an HC-SR04 and print it to serial' },
  { icon: '🔘', text: 'Add a button that lights an LED while pressed' },
  { icon: '🎚️', text: 'Dim an LED with a potentiometer (PWM breathing light)' },
  { icon: '❓', text: 'Why does an LED need a series resistor?' },
  { icon: '📚', text: 'What is PWM? Demonstrate it in my circuit' },
];

const TOOL_ICONS: Record<string, string> = {
  get_project: '📋',
  list_component_types: '🔍',
  get_pins: '🧷',
  add_board: '🖥️',
  remove_board: '🗑️',
  set_active_board: '🖥️',
  set_board_language: '🌐',
  add_component: '💡',
  update_component: '✏️',
  remove_component: '🗑️',
  add_wire: '🔌',
  remove_wire: '✂️',
  write_file: '📄',
  edit_file: '✏️',
  delete_file: '🗑️',
  install_library: '📦',
  compile: '⚙️',
  run_simulation: '▶️',
  stop_simulation: '⏹️',
  read_serial: '📟',
  observe_simulation: '👁️',
  interact: '🖱️',
  check_circuit: '🩺',
  search_libraries: '📚',
  search_examples: '🗂️',
  get_example: '📖',
  save_version: '🕘',
  list_versions: '🕘',
  restore_version: '⏮️',
};

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="agent-diff">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+')
              ? 'agent-diff__add'
              : line.startsWith('-')
                ? 'agent-diff__del'
                : 'agent-diff__ctx'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function ToolChip({ seg }: { seg: Extract<UiSegment, { kind: 'tool' }> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const icon =
    seg.status === 'running' ? '◌' : seg.status === 'error' ? '✗' : (TOOL_ICONS[seg.name] ?? '✓');
  return (
    <div
      className={`agent-tool-chip agent-tool-chip--${seg.status}`}
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? undefined : t('agent.expand')}
    >
      <span className="agent-tool-chip__icon">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {seg.label}
        {expanded && seg.diff && <DiffView diff={seg.diff} />}
        {expanded && seg.detail && !seg.diff && (
          <pre className="agent-tool-chip__detail">{seg.detail}</pre>
        )}
      </div>
    </div>
  );
}

function SettingsView() {
  const { t } = useTranslation();
  const {
    settings,
    updateSettings,
    serverConfig,
    testConnection,
    setSettingsOpen,
    modelList,
    fetchModels,
  } = useAgentStore();
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; latency_ms?: number } | null>(
    null,
  );

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    setResult(await testConnection());
    setTesting(false);
  };

  const handleFetchModels = async () => {
    setLoadingModels(true);
    const r = await fetchModels();
    if (!r.ok) setResult({ ok: false, message: r.message ?? 'failed' });
    setLoadingModels(false);
  };

  // Admin platform settings gate what users may change here. Default to
  // permissive when the config hasn't loaded (matches previous behaviour).
  const allowOwnKey = serverConfig?.allow_own_key !== false;
  const allowCustomModel = serverConfig?.allow_custom_model !== false;

  return (
    <div className="agent-settings">
      <h3>{t('agent.settings')}</h3>
      <p className="agent-settings__hint">{t('agent.settingsHint')}</p>

      {!allowCustomModel && (
        <p className="agent-settings__hint">
          {t('agent.modelLocked', '模型由平台統一設定:')}
          <strong>
            {serverConfig?.model}
            {serverConfig?.effort ? `(${serverConfig.effort})` : ''}
          </strong>
        </p>
      )}

      {allowOwnKey && (
        <>
          <label>
            {t('agent.baseUrl')}
            <input
              type="text"
              value={settings.baseUrl ?? ''}
              placeholder={serverConfig?.base_url || 'https://api.example.com/v1'}
              onChange={(e) => updateSettings({ baseUrl: e.target.value })}
              spellCheck={false}
            />
          </label>

          <label>
            {t('agent.apiKey')}
            <input
              type="password"
              value={settings.apiKey ?? ''}
              placeholder={serverConfig?.server_has_key ? t('agent.apiKeyServerSet') : 'sk-...'}
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              spellCheck={false}
            />
          </label>
        </>
      )}

      {allowCustomModel && (
        <label>
          {t('agent.model')}
          <input
            type="text"
            list="agent-model-list"
            value={settings.model ?? ''}
            placeholder={serverConfig?.model || 'gpt-5.6-luna'}
            onChange={(e) => updateSettings({ model: e.target.value })}
            spellCheck={false}
          />
          <datalist id="agent-model-list">
            {modelList.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      )}

      <label>
        {t('agent.contextLimit')}
        <input
          type="number"
          min={1000}
          step={1000}
          value={settings.contextLimitTokens ?? ''}
          placeholder="100000"
          onChange={(e) =>
            updateSettings({ contextLimitTokens: Number(e.target.value) || undefined })
          }
        />
      </label>

      {allowCustomModel && (
        <div className="agent-settings__row">
          <label>
            {t('agent.effort')}
            <select
              value={settings.effort ?? ''}
              onChange={(e) => updateSettings({ effort: e.target.value || undefined })}
            >
              <option value="">
                {t('agent.effortDefault', {
                  value: serverConfig?.effort || t('agent.effortOff'),
                })}
              </option>
              <option value="none">{t('agent.effortNone')}</option>
              <option value="low">{t('agent.effortLow')}</option>
              <option value="medium">medium</option>
              <option value="high">{t('agent.effortHigh')}</option>
            </select>
          </label>
          <label>
            &nbsp;
            <button
              className="agent-settings__test"
              onClick={handleFetchModels}
              disabled={loadingModels}
            >
              {loadingModels ? t('agent.modelListLoading') : t('agent.modelListFetch')}
            </button>
          </label>
        </div>
      )}

      <div className="agent-settings__actions">
        <button className="agent-settings__test" onClick={handleTest} disabled={testing}>
          {testing ? t('agent.testing') : t('agent.test')}
        </button>
        <button className="agent-settings__test" onClick={() => setSettingsOpen(false)}>
          {t('agent.back')}
        </button>
      </div>

      {result && (
        <div
          className={`agent-settings__result agent-settings__result--${result.ok ? 'ok' : 'fail'}`}
        >
          {result.ok
            ? t('agent.testOk', { message: result.message, ms: result.latency_ms ?? '?' })
            : t('agent.testFail', { message: result.message })}
        </div>
      )}
    </div>
  );
}

/** Cloud chat-session history view (fork feature). */
function HistoryView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const chats = useCloudStore((s) => s.chats);
  const currentChatId = useCloudStore((s) => s.currentChatId);
  const refreshChats = useCloudStore((s) => s.refreshChats);
  const loadChat = useCloudStore((s) => s.loadChat);
  const deleteChat = useCloudStore((s) => s.deleteChat);
  const startNewChat = useCloudStore((s) => s.startNewChat);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) void refreshChats();
  }, [user, refreshChats]);

  if (!user) {
    return (
      <div className="agent-settings">
        <h3>{t('cloud.chatHistory')}</h3>
        <p className="agent-settings__hint">{t('cloud.signInForHistory')}</p>
        <button className="agent-settings__test" onClick={() => setAuthModalOpen(true)}>
          {t('cloud.signIn')}
        </button>
        <button className="agent-settings__test" onClick={onClose}>
          {t('agent.back')}
        </button>
      </div>
    );
  }

  const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString();

  return (
    <div className="agent-settings">
      <h3>{t('cloud.chatHistory')}</h3>
      <div className="agent-settings__actions">
        <button
          className="agent-settings__test"
          onClick={() => {
            startNewChat();
            onClose();
          }}
        >
          {t('cloud.newChat')}
        </button>
        <button className="agent-settings__test" onClick={onClose}>
          {t('agent.back')}
        </button>
      </div>
      {error && <div className="cloud-error">{error}</div>}
      <div className="cloud-list">
        {chats.length === 0 && <div className="cloud-empty">{t('cloud.noChats')}</div>}
        {chats.map((c) => (
          <div
            key={c.id}
            className={`cloud-list__row${c.id === currentChatId ? ' cloud-list__row--current' : ''}`}
          >
            <div
              className="cloud-list__main"
              onClick={async () => {
                if (c.id === currentChatId) return onClose();
                const ok = await showConfirmDialog(t('cloud.loadChatConfirm'));
                if (!ok) return;
                try {
                  await loadChat(c.id);
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <div className="cloud-list__name">
                {c.title}
                {c.id === currentChatId ? ` · ${t('cloud.currentChat')}` : ''}
              </div>
              <div className="cloud-list__meta">{fmtDate(c.updated_at)}</div>
            </div>
            <button
              className="cloud-list__action"
              title={t('cloud.delete')}
              onClick={async () => {
                const ok = await showConfirmDialog(t('cloud.deleteChatConfirm'));
                if (!ok) return;
                try {
                  await deleteChat(c.id);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ m }: { m: UiMessage }) {
  const { t } = useTranslation();
  const hasCheckpoint = useAgentStore((s) => s.checkpoints.some((c) => c.msgId === m.id));
  const busy = useAgentStore((s) => s.busy);
  const restoreToTurn = useAgentStore((s) => s.restoreToTurn);

  const handleRestore = async () => {
    if (busy) return;
    const ok = await showConfirmDialog(t('agent.restoreConfirm'));
    if (ok) await restoreToTurn(m.id);
  };

  return (
    <div className="agent-msg agent-msg--user">
      {m.segments.map((seg) => (seg.kind === 'text' ? seg.text : null))[0] ?? ''}
      {hasCheckpoint && !busy && (
        <button className="agent-msg__restore" title={t('agent.restore')} onClick={handleRestore}>
          ⟲
        </button>
      )}
    </div>
  );
}

export function AgentChatPanel() {
  const { t, i18n } = useTranslation();
  const store = useAgentStore();
  const {
    panelOpen,
    panelWidth,
    setPanelWidth,
    settingsOpen,
    setSettingsOpen,
    messages,
    busy,
    send,
    stop,
    clearChat,
    retry,
    serverConfig,
    fetchConfig,
  } = store;

  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const cloudUser = useCloudStore((s) => s.user);
  const chatSyncState = useCloudStore((s) => s.chatSyncState);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (panelOpen && serverConfig === null) void fetchConfig();
  }, [panelOpen, serverConfig, fetchConfig]);

  // Smart autoscroll: follow the stream only while the user is near the
  // bottom; don't yank them back down while they're reading older messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  // Auto-grow the textarea with content
  const autoGrow = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
  }, []);
  useEffect(autoGrow, [draft, autoGrow]);

  // Width resize (desktop): drag the panel's left edge.
  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      const startX = e.clientX;
      const startW = panelWidth;
      const onMove = (ev: MouseEvent) => setPanelWidth(startW + (startX - ev.clientX));
      const onUp = () => {
        setResizing(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [panelWidth, setPanelWidth],
  );

  if (!panelOpen) return null;

  const keyMissing = needsApiKey(store);
  const model = effectiveModel(store);
  // Steering: the composer stays usable while the agent works — Enter queues
  // the message into the active run instead of being blocked.
  const canSend = draft.trim().length > 0 && !keyMissing;
  const suggestions = i18n.language.toLowerCase().startsWith('zh')
    ? SUGGESTIONS_ZH
    : SUGGESTIONS_EN;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft.trim();
    setDraft('');
    stickToBottomRef.current = true;
    if (busy) store.steer(text);
    else void send(text);
  };

  return (
    <div className="agent-panel" style={{ width: panelWidth }}>
      <div
        className={`agent-panel__resize${resizing ? ' agent-panel__resize--active' : ''}`}
        onMouseDown={handleResizeDown}
      />

      <div className="agent-panel__header">
        <span className="agent-panel__title">
          <span>✨</span>
          <span>{t('agent.title')}</span>
          {model && (
            <span
              className="agent-panel__model-chip"
              onClick={() => setSettingsOpen(true)}
              title={t('agent.modelChip', { model })}
            >
              {model}
            </span>
          )}
          {cloudUser && (
            <span
              className="agent-panel__sync"
              title={
                chatSyncState === 'error'
                  ? t('cloud.syncError')
                  : chatSyncState === 'saving'
                    ? t('cloud.syncSaving')
                    : t('cloud.syncSaved')
              }
            >
              {chatSyncState === 'error' ? '☁⚠' : chatSyncState === 'saving' ? '☁…' : '☁✓'}
            </span>
          )}
        </span>
        <button
          className={`agent-panel__iconbtn${historyOpen ? ' agent-panel__iconbtn--active' : ''}`}
          onClick={() => {
            setHistoryOpen(!historyOpen);
            if (!historyOpen) setSettingsOpen(false);
          }}
          title={t('cloud.chatHistory')}
          aria-label={t('cloud.chatHistory')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </button>
        <button
          className={`agent-panel__iconbtn${settingsOpen ? ' agent-panel__iconbtn--active' : ''}`}
          onClick={() => setSettingsOpen(!settingsOpen)}
          title={t('agent.settings')}
          aria-label={t('agent.settings')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          className="agent-panel__iconbtn"
          onClick={clearChat}
          title={t('agent.clear')}
          aria-label={t('agent.clear')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
        </button>
        <button
          className="agent-panel__iconbtn"
          onClick={store.togglePanel}
          title={t('agent.close')}
          aria-label={t('agent.close')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {settingsOpen ? (
        <SettingsView />
      ) : historyOpen ? (
        <HistoryView onClose={() => setHistoryOpen(false)} />
      ) : (
        <>
          {keyMissing && (
            <div className="agent-panel__keybox">
              <Trans
                i18nKey="agent.needKey"
                components={{ 1: <a onClick={() => setSettingsOpen(true)} /> }}
              />
            </div>
          )}

          <div className="agent-panel__messages" ref={scrollRef} onScroll={handleScroll}>
            {messages.length === 0 && !keyMissing && (
              <div className="agent-panel__empty">
                <div className="agent-panel__empty-icon">✨</div>
                <div>{t('agent.emptyTitle')}</div>
                <div className="agent-panel__empty-sub">{t('agent.emptySub')}</div>
                <div className="agent-panel__suggestions">
                  {suggestions.map((s) => (
                    <button key={s.text} onClick={() => void send(s.text)}>
                      <span>{s.icon}</span>
                      <span>{s.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} m={m} />
              ) : (
                <div key={m.id} className="agent-msg agent-msg--assistant">
                  <div className="agent-msg__avatar">✨</div>
                  <div className="agent-msg__body">
                    {m.segments.map((seg, i) =>
                      seg.kind === 'text' ? (
                        <div key={i} className="agent-md">
                          <ReactMarkdown>{seg.text}</ReactMarkdown>
                        </div>
                      ) : seg.kind === 'notice' ? (
                        <div key={i} className="agent-msg__notice">
                          🗜️ {t('agent.compacted')}
                        </div>
                      ) : (
                        <ToolChip key={i} seg={seg} />
                      ),
                    )}
                    {m.error && (
                      <div className="agent-msg__error">
                        {t('agent.error', { message: m.error })}
                        <br />
                        <button onClick={retry}>{t('agent.retry')}</button>
                      </div>
                    )}
                    {m.usage && (
                      <div className="agent-msg__usage">
                        {t('agent.usage', { input: m.usage.input, output: m.usage.output })}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}

            {(() => {
              // Liveness hint while the model is thinking (before the first
              // text, and again between tool calls). Hidden while text streams.
              if (!busy) return null;
              const last = messages[messages.length - 1];
              if (!last || last.role !== 'assistant') return null;
              const lastSeg = last.segments[last.segments.length - 1];
              if (lastSeg && lastSeg.kind === 'text') return null;
              return (
                <div className="agent-panel__status">
                  <span className="agent-panel__status-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {(last.thinkingChars ?? 0) > 0
                    ? t('agent.deepThinking', { chars: last.thinkingChars })
                    : t('agent.thinking')}
                </div>
              );
            })()}
          </div>

          <AgentUsageMeter />

          <div className="agent-panel__composer">
            {store.cappedRun && !busy && (
              <div className="agent-panel__capped">
                {t('agent.capped')}
                <button onClick={store.continueRun}>{t('agent.continue')}</button>
              </div>
            )}
            {store.pendingSteering.length > 0 && (
              <div className="agent-panel__queued">
                {store.pendingSteering.map((text, i) => (
                  <span key={`${i}-${text.slice(0, 12)}`} className="agent-panel__queued-chip">
                    <span className="agent-panel__queued-text">{text}</span>
                    <button
                      onClick={() => store.unqueueSteering(i)}
                      title={t('agent.unqueue')}
                      aria-label={t('agent.unqueue')}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="agent-panel__inputwrap">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder={busy ? t('agent.steerPlaceholder') : t('agent.placeholder')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              {busy && (
                <button
                  className="agent-panel__stop"
                  onClick={stop}
                  title={t('agent.stop')}
                  aria-label={t('agent.stop')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </button>
              )}
              <button
                className="agent-panel__send"
                disabled={!canSend}
                onClick={handleSend}
                title={busy ? t('agent.steer') : t('agent.send')}
                aria-label={busy ? t('agent.steer') : t('agent.send')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>
            <div className="agent-panel__hint">{t('agent.hint')}</div>
          </div>
        </>
      )}
    </div>
  );
}
