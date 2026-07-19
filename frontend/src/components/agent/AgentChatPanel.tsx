/**
 * AI assistant chat panel — right-docked drawer on the editor page.
 *
 * The OSS counterpart of the velxio.dev pro "AI Co-pilot": chat with an agent
 * that reads the live project state and builds/edits code, components, and
 * wiring through tools. See docs/wiki/ai-assistant.md.
 */

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAgentStore } from '../../store/useAgentStore';
import type { UiSegment } from '../../agent/types';
import './AgentChatPanel.css';

const SUGGESTIONS = [
  '搭一个红绿灯:红黄绿三个 LED 轮流亮',
  '用 HC-SR04 超声波传感器测距,把距离打印到串口',
  '加一个按钮,按下时点亮 LED',
  'Build a potentiometer-controlled LED dimmer',
];

function ToolChip({ seg }: { seg: Extract<UiSegment, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const icon = seg.status === 'running' ? '◐' : seg.status === 'ok' ? '✓' : '✗';
  return (
    <div
      className={`agent-tool-chip agent-tool-chip--${seg.status}`}
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? undefined : '点击查看详情'}
    >
      <span className="agent-tool-chip__icon">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {seg.label}
        {expanded && seg.detail && <pre className="agent-tool-chip__detail">{seg.detail}</pre>}
      </div>
    </div>
  );
}

export function AgentChatPanel() {
  const {
    panelOpen,
    togglePanel,
    messages,
    busy,
    send,
    stop,
    clearChat,
    serverHasKey,
    backendEnabled,
    apiKey,
    setApiKey,
    fetchConfig,
  } = useAgentStore();

  const [draft, setDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelOpen && serverHasKey === null) void fetchConfig();
  }, [panelOpen, serverHasKey, fetchConfig]);

  // Keep the newest message in view while streaming
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  if (!panelOpen) {
    return (
      <button className="agent-fab" onClick={togglePanel} title="AI Assistant">
        ✨ AI 助手
      </button>
    );
  }

  const needsKey = serverHasKey === false && !apiKey;
  const canSend = !busy && draft.trim().length > 0 && !needsKey && backendEnabled !== false;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft.trim();
    setDraft('');
    void send(text);
  };

  return (
    <div className="agent-panel">
      <div className="agent-panel__header">
        <span className="agent-panel__title">✨ AI 助手 · AI Assistant</span>
        <button onClick={clearChat} title="清空对话 / Clear chat">
          清空
        </button>
        <button onClick={togglePanel} title="关闭 / Close">
          ✕
        </button>
      </div>

      {backendEnabled === false && (
        <div className="agent-panel__keybox">
          后端未安装 <code>anthropic</code> 包 — 在 backend 目录运行{' '}
          <code>pip install anthropic</code> 后重启服务。
        </div>
      )}

      {needsKey && backendEnabled !== false && (
        <div className="agent-panel__keybox">
          <div>
            服务器未配置 API Key。输入你自己的 Anthropic API Key(只保存在本机浏览器中),或在服务器上设置{' '}
            <code>ANTHROPIC_API_KEY</code> 环境变量。
            <br />
            <a href="https://platform.claude.com/" target="_blank" rel="noreferrer">
              获取 API Key →
            </a>
          </div>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyDraft.trim()) setApiKey(keyDraft.trim());
            }}
          />
          <button
            className="agent-panel__send"
            style={{ marginTop: 8 }}
            disabled={!keyDraft.trim()}
            onClick={() => setApiKey(keyDraft.trim())}
          >
            保存
          </button>
        </div>
      )}

      <div className="agent-panel__messages" ref={scrollRef}>
        {messages.length === 0 && !needsKey && (
          <div className="agent-panel__empty">
            <div>用自然语言描述你想做的项目,AI 会自动搭电路、接线、写代码并编译运行。</div>
            <div style={{ marginTop: 4, fontSize: 11.5 }}>
              Describe a project in plain language — the AI builds the circuit, wiring and code.
            </div>
            <div className="agent-panel__suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)}>
                  {s}
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
                  出错了: {m.error}
                  <br />
                  可以重新发送消息重试。
                </div>
              )}
            </div>
          ),
        )}
        {busy && messages[messages.length - 1]?.segments.length === 0 && (
          <div className="agent-panel__empty">思考中…</div>
        )}
      </div>

      <div className="agent-panel__composer">
        <textarea
          placeholder="例如:做一个呼吸灯 / e.g. Build a breathing LED"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={busy}
        />
        <div className="agent-panel__composer-row">
          <span className="agent-panel__hint">Enter 发送 · Shift+Enter 换行</span>
          {busy ? (
            <button className="agent-panel__stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="agent-panel__send" disabled={!canSend} onClick={handleSend}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
