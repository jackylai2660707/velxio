/**
 * AI assistant chat panel — right-DOCKED pane on desktop (flex child of
 * .app-container, so the canvas shrinks and nothing is overlapped),
 * fullscreen sheet on mobile. Opened from the toolbar / mobile tab bar via
 * useAgentStore.togglePanel().
 *
 * The OSS counterpart of the velxio.dev pro "AI Co-pilot": chat with an agent
 * that reads the live project state and builds/edits code, components, and
 * wiring through tools. Primary provider is any OpenAI-compatible endpoint,
 * configurable in the panel's settings view. See docs/wiki/ai-assistant.md.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAgentStore, needsApiKey, effectiveModel } from '../../store/useAgentStore';
import type { UiSegment } from '../../agent/types';
import './AgentChatPanel.css';

const SUGGESTIONS: Array<{ icon: string; text: string }> = [
  { icon: '🚦', text: '搭一个红绿灯:红黄绿三个 LED 轮流亮' },
  { icon: '📏', text: '用 HC-SR04 超声波传感器测距,把距离打印到串口' },
  { icon: '🔘', text: '加一个按钮,按下时点亮 LED' },
  { icon: '🎚️', text: '用电位器控制 LED 亮度(PWM 呼吸灯)' },
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
};

function ToolChip({ seg }: { seg: Extract<UiSegment, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const icon =
    seg.status === 'running' ? '◌' : seg.status === 'error' ? '✗' : (TOOL_ICONS[seg.name] ?? '✓');
  return (
    <div
      className={`agent-tool-chip agent-tool-chip--${seg.status}`}
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? undefined : '点击展开详情'}
    >
      <span className="agent-tool-chip__icon">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {seg.label}
        {expanded && seg.detail && <pre className="agent-tool-chip__detail">{seg.detail}</pre>}
      </div>
    </div>
  );
}

function SettingsView() {
  const { settings, updateSettings, serverConfig, testConnection, setSettingsOpen } =
    useAgentStore();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; latency_ms?: number } | null>(
    null,
  );

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    setResult(await testConnection());
    setTesting(false);
  };

  const ph = (userValue: string | undefined, envValue: string | undefined, fallback: string) =>
    userValue !== undefined ? undefined : envValue ? `${envValue}(服务器默认)` : fallback;

  return (
    <div className="agent-settings">
      <h3>接口设置</h3>
      <p className="agent-settings__hint">
        留空的项使用服务器端环境变量的默认值。所有设置只保存在你自己的浏览器中。
      </p>

      <label>
        Provider
        <select
          value={settings.provider ?? ''}
          onChange={(e) =>
            updateSettings({
              provider: (e.target.value || undefined) as 'openai' | 'anthropic' | undefined,
            })
          }
        >
          <option value="">默认({serverConfig?.provider || 'openai'})</option>
          <option value="openai">OpenAI 兼容接口</option>
          <option value="anthropic">Anthropic 官方</option>
        </select>
      </label>

      <label>
        Base URL(OpenAI 兼容,含 /v1)
        <input
          type="text"
          value={settings.baseUrl ?? ''}
          placeholder={ph(settings.baseUrl, serverConfig?.base_url, 'https://api.example.com/v1')}
          onChange={(e) => updateSettings({ baseUrl: e.target.value })}
          spellCheck={false}
        />
      </label>

      <label>
        API Key
        <input
          type="password"
          value={settings.apiKey ?? ''}
          placeholder={
            serverConfig?.server_has_key ? '(服务器已配置,可留空)' : 'sk-... / 你的中转站 Key'
          }
          onChange={(e) => updateSettings({ apiKey: e.target.value })}
          spellCheck={false}
        />
      </label>

      <div className="agent-settings__row">
        <label>
          模型
          <input
            type="text"
            value={settings.model ?? ''}
            placeholder={ph(settings.model, serverConfig?.model, 'gpt-4o')}
            onChange={(e) => updateSettings({ model: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          推理力度
          <select
            value={settings.effort ?? ''}
            onChange={(e) => updateSettings({ effort: e.target.value || undefined })}
          >
            <option value="">默认({serverConfig?.effort || '关'})</option>
            <option value="none">关闭</option>
            <option value="low">low(最快)</option>
            <option value="medium">medium</option>
            <option value="high">high(最强)</option>
          </select>
        </label>
      </div>

      <div className="agent-settings__actions">
        <button className="agent-settings__test" onClick={handleTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button className="agent-settings__test" onClick={() => setSettingsOpen(false)}>
          返回对话
        </button>
      </div>

      {result && (
        <div
          className={`agent-settings__result agent-settings__result--${result.ok ? 'ok' : 'fail'}`}
        >
          {result.ok
            ? `✓ 连接成功 · ${result.message} · ${result.latency_ms ?? '?'}ms`
            : `✗ 连接失败:${result.message}`}
        </div>
      )}
    </div>
  );
}

export function AgentChatPanel() {
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
  const canSend = !busy && draft.trim().length > 0 && !keyMissing;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft.trim();
    setDraft('');
    stickToBottomRef.current = true;
    void send(text);
  };

  return (
    <div className="agent-panel" style={{ width: panelWidth }}>
      <div
        className={`agent-panel__resize${resizing ? ' agent-panel__resize--active' : ''}`}
        onMouseDown={handleResizeDown}
        title="拖动调整宽度"
      />

      <div className="agent-panel__header">
        <span className="agent-panel__title">
          <span>✨</span>
          <span>AI 助手</span>
          {model && (
            <span
              className="agent-panel__model-chip"
              onClick={() => setSettingsOpen(true)}
              title={`当前模型:${model}(点击修改)`}
            >
              {model}
            </span>
          )}
        </span>
        <button
          className={`agent-panel__iconbtn${settingsOpen ? ' agent-panel__iconbtn--active' : ''}`}
          onClick={() => setSettingsOpen(!settingsOpen)}
          title="接口设置"
          aria-label="接口设置"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button className="agent-panel__iconbtn" onClick={clearChat} title="清空对话" aria-label="清空对话">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          </svg>
        </button>
        <button className="agent-panel__iconbtn" onClick={store.togglePanel} title="关闭" aria-label="关闭">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {settingsOpen ? (
        <SettingsView />
      ) : (
        <>
          {keyMissing && (
            <div className="agent-panel__keybox">
              还没有可用的 API Key —{' '}
              <a onClick={() => setSettingsOpen(true)}>打开接口设置</a>{' '}
              填入你的 OpenAI 兼容接口地址和 Key(只保存在本机浏览器)。
            </div>
          )}

          <div className="agent-panel__messages" ref={scrollRef} onScroll={handleScroll}>
            {messages.length === 0 && !keyMissing && (
              <div className="agent-panel__empty">
                <div className="agent-panel__empty-icon">✨</div>
                <div>用自然语言描述项目,AI 自动搭电路、接线、写代码、编译运行。</div>
                <div className="agent-panel__empty-sub">
                  生成之后你可以随意手动修改,AI 每轮都会读取最新状态。
                </div>
                <div className="agent-panel__suggestions">
                  {SUGGESTIONS.map((s) => (
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
                <div key={m.id} className="agent-msg agent-msg--user">
                  {m.segments.map((seg) => (seg.kind === 'text' ? seg.text : null))[0] ?? ''}
                </div>
              ) : (
                <div key={m.id} className="agent-msg agent-msg--assistant">
                  <div className="agent-msg__avatar">✨</div>
                  <div className="agent-msg__body">
                    {m.segments.map((seg, i) =>
                      seg.kind === 'text' ? (
                        <div key={i} className="agent-md">
                          <ReactMarkdown>{seg.text}</ReactMarkdown>
                        </div>
                      ) : (
                        <ToolChip key={i} seg={seg} />
                      ),
                    )}
                    {m.error && (
                      <div className="agent-msg__error">
                        出错了:{m.error}
                        <br />
                        <button onClick={retry}>重试</button>
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
                    ? `深度思考中 · 已推理 ${last.thinkingChars} 字`
                    : '思考中'}
                </div>
              );
            })()}
          </div>

          <div className="agent-panel__composer">
            <div className="agent-panel__inputwrap">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder="描述你想做的项目,例如:做一个呼吸灯"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              {busy ? (
                <button className="agent-panel__stop" onClick={stop} title="停止生成" aria-label="停止生成">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className="agent-panel__send"
                  disabled={!canSend}
                  onClick={handleSend}
                  title="发送"
                  aria-label="发送"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              )}
            </div>
            <div className="agent-panel__hint">Enter 发送 · Shift+Enter 换行</div>
          </div>
        </>
      )}
    </div>
  );
}
