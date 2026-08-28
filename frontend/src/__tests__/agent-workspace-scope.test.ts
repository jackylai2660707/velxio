import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useAgentStore } from '../store/useAgentStore';
import type { ApiMessage, UiMessage } from '../agent/types';
import { chatApi } from '../cloud/cloudApi';
import { useCloudStore } from '../cloud/useCloudStore';

// The cloud auto-sync subscriber intentionally installs only in a browser.
// This test file runs under Vitest's node environment, so provide the smallest
// browser marker before the imported stores initialise. No DOM APIs are needed.
vi.hoisted(() => {
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
  }
});

const userMessage = (text: string): UiMessage => ({
  id: `scope-${text}`,
  role: 'user',
  segments: [{ kind: 'text', text }],
});

describe('agent workspace context isolation', () => {
  beforeEach(() => {
    useAgentStore.setState({
      workspaceScope: 'scratch',
      messages: [],
      apiMessages: [],
      busy: false,
      abortController: null,
      checkpoints: [],
      totalTokens: { input: 0, output: 0 },
      lastPromptTokens: 900,
    });
    useCloudStore.setState({
      user: null,
      currentChatId: null,
      chatSyncState: 'idle',
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      localStorage.removeItem('velxio-agent-chat-scoped-v1');
      localStorage.removeItem('velxio-agent-chat');
    } catch {
      /* node/private mode */
    }
  });

  it('clears API/UI history and token meter when workspace changes', () => {
    const api: ApiMessage = { role: 'user', content: [{ type: 'text', text: 'old lesson' }] };
    useAgentStore.setState({ messages: [userMessage('old')], apiMessages: [api] });
    useAgentStore.getState().switchWorkspaceScope('lesson:course-a:lesson-2:example:fade-led');
    const state = useAgentStore.getState();
    expect(state.workspaceScope).toContain('course-a');
    expect(state.messages).toEqual([]);
    expect(state.apiMessages).toEqual([]);
    expect(state.totalTokens).toEqual({ input: 0, output: 0 });
    expect(state.lastPromptTokens).toBe(0);
  });

  it('separates two lessons that intentionally reuse the same example', () => {
    const lessonOne = 'lesson:arduino-basics:intro:example:blink-led';
    const lessonTwo = 'lesson:arduino-basics:blink:example:blink-led';

    useAgentStore.getState().switchWorkspaceScope(lessonOne);
    useAgentStore.setState({ messages: [userMessage('lesson one notes')] });

    useAgentStore.getState().switchWorkspaceScope(lessonTwo);
    expect(useAgentStore.getState().workspaceScope).toBe(lessonTwo);
    expect(useAgentStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().apiMessages).toEqual([]);
  });

  it('does not reset again when the same workspace is reloaded', () => {
    useAgentStore.setState({ messages: [userMessage('keep')] });
    useAgentStore.getState().switchWorkspaceScope('example:same');
    useAgentStore.setState({ messages: [userMessage('new work')] });
    useAgentStore.getState().switchWorkspaceScope('example:same');
    expect(useAgentStore.getState().messages[0]?.segments[0]).toEqual({ kind: 'text', text: 'new work' });
  });

  it('does not run a pending cloud debounce after a workspace switch', async () => {
    vi.useFakeTimers();
    const upsert = vi.spyOn(chatApi, 'upsert').mockResolvedValue({ id: 'chat-new' });
    const user = { id: 'student-1', email: 'student@example.test', name: 'Student' };

    useCloudStore.setState({ user, currentChatId: 'chat-old', chatSyncState: 'idle' });
    useAgentStore.setState({
      workspaceScope: 'lesson:old',
      messages: [userMessage('old lesson')],
    });
    // A settled message update is what the production subscriber debounces.
    useAgentStore.setState({ messages: [userMessage('old lesson, final')] });

    useAgentStore.getState().switchWorkspaceScope('lesson:new');
    await vi.advanceTimersByTimeAsync(3500);

    expect(upsert).not.toHaveBeenCalled();
    expect(useCloudStore.getState().currentChatId).toBeNull();
    expect(useAgentStore.getState().messages).toEqual([]);
  });

  it('drops an in-flight cloud response after a workspace switch', async () => {
    vi.useFakeTimers();
    let resolveUpsert: ((value: { id: string }) => void) | undefined;
    const upsert = vi.spyOn(chatApi, 'upsert').mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const user = { id: 'student-1', email: 'student@example.test', name: 'Student' };

    useCloudStore.setState({ user, currentChatId: 'chat-old', chatSyncState: 'idle' });
    useAgentStore.setState({
      workspaceScope: 'lesson:old',
      messages: [userMessage('old lesson')],
      apiMessages: [
        { role: 'user', content: [{ type: 'text', text: 'old lesson' }] },
      ],
    });
    const pending = useCloudStore.getState().syncCurrentChat();
    expect(upsert).toHaveBeenCalledTimes(1);

    useAgentStore.getState().switchWorkspaceScope('lesson:new');
    resolveUpsert?.({ id: 'chat-old' });
    await pending;

    // The old request may finish on the wire, but it cannot attach its id or
    // status to the new lesson after the scope-generation check.
    expect(useCloudStore.getState().currentChatId).toBeNull();
    expect(useCloudStore.getState().chatSyncState).toBe('idle');
    expect(useAgentStore.getState().workspaceScope).toBe('lesson:new');
    expect(useAgentStore.getState().messages).toEqual([]);
  });
});
