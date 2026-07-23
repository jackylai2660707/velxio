/**
 * HTTP client for the fork's self-contained cloud (backend /api/auth +
 * /api/cloud). Token lives in localStorage and rides in the Authorization
 * header; every helper throws CloudApiError with the server's message so
 * the store/UI can surface it directly.
 */

import { getApiBase } from '../lib/apiBase';
import type { ApiMessage, UiMessage } from '../agent/types';
import type { VlxPayload } from '../utils/vlxFile';

const TOKEN_STORAGE = 'velxio-cloud-token';

export class CloudApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE, token);
    else localStorage.removeItem(TOKEN_STORAGE);
  } catch {
    /* private mode */
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${getApiBase()}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (typeof j.detail === 'string') detail = j.detail;
    } catch {
      /* keep status text */
    }
    throw new CloudApiError(resp.status, detail);
  }
  return (await resp.json()) as T;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  /** 'teacher' unlocks the class-management dashboard; default 'student'. */
  role?: 'student' | 'teacher';
}

export const authApi = {
  register: (email: string, password: string, name: string) =>
    request<{ token: string; user: CloudUser }>('POST', '/auth/register', {
      email,
      password,
      name,
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: CloudUser }>('POST', '/auth/login', { email, password }),
  me: () => request<{ user: CloudUser }>('GET', '/auth/me'),
};

// ── Projects ───────────────────────────────────────────────────────────────

export interface CloudProjectMeta {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  size: number;
}

export const projectApi = {
  list: () => request<{ projects: CloudProjectMeta[] }>('GET', '/cloud/projects'),
  create: (name: string, data: VlxPayload) =>
    request<{ id: string }>('POST', '/cloud/projects', { name, data }),
  get: (id: string) =>
    request<{ id: string; name: string; data: VlxPayload }>('GET', `/cloud/projects/${id}`),
  update: (id: string, patch: { name?: string; data?: VlxPayload }) =>
    request<{ ok: boolean }>('PUT', `/cloud/projects/${id}`, patch),
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/cloud/projects/${id}`),
};

// ── Chat sessions ──────────────────────────────────────────────────────────

export interface CloudChatMeta {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  size: number;
}

export const chatApi = {
  list: () => request<{ chats: CloudChatMeta[] }>('GET', '/cloud/chats'),
  upsert: (payload: {
    id?: string;
    title: string;
    messages: UiMessage[];
    api_messages: ApiMessage[];
  }) => request<{ id: string }>('POST', '/cloud/chats', payload),
  get: (id: string) =>
    request<{
      id: string;
      title: string;
      messages: UiMessage[];
      api_messages: ApiMessage[];
    }>('GET', `/cloud/chats/${id}`),
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/cloud/chats/${id}`),
};
