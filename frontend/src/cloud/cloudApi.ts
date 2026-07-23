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
  /** 'teacher' unlocks class management; 'admin' the operator dashboard. */
  role?: 'student' | 'teacher' | 'admin';
}

/** Current-week AI token usage for the signed-in user. */
export interface AiUsage {
  week_start: string;
  used: number;
  limit: number;
  is_custom_limit: boolean;
}

export const authApi = {
  register: (
    email: string,
    password: string,
    name: string,
    role: 'student' | 'teacher' = 'student',
    teacherCode = '',
  ) =>
    request<{ token: string; user: CloudUser }>('POST', '/auth/register', {
      email,
      password,
      name,
      role,
      teacher_code: teacherCode,
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: CloudUser }>('POST', '/auth/login', { email, password }),
  me: () => request<{ user: CloudUser }>('GET', '/auth/me'),
  usage: () => request<AiUsage>('GET', '/auth/usage'),
};

// ── Admin (platform operator) ──────────────────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  weekly_token_limit: number | null;
  effective_limit: number;
  used_this_week: number;
}

export interface AdminBatchResult {
  created: { email: string; password: string; name: string }[];
  skipped: string[];
  joined_class: number;
}

export interface PlatformSettings {
  ai_model: string;
  ai_effort: 'low' | 'medium' | 'high';
  allow_custom_model: boolean;
  allow_own_key: boolean;
  student_weekly_tokens: number;
  teacher_weekly_tokens: number;
  allow_registration: boolean;
  teacher_code: string;
}

export const adminApi = {
  overview: () =>
    request<{
      week_start: string;
      users: Record<string, number>;
      classes: number;
      week_tokens: number;
      default_weekly_limit: number;
      teacher_weekly_limit: number;
    }>('GET', '/admin/overview'),
  getSettings: () => request<PlatformSettings>('GET', '/admin/settings'),
  putSettings: (patch: Partial<PlatformSettings>) =>
    request<PlatformSettings>('PUT', '/admin/settings', patch),
  listUsers: (query = '') =>
    request<{ users: AdminUserRow[] }>('GET', `/admin/users?query=${encodeURIComponent(query)}`),
  batchCreate: (payload: {
    role: 'student' | 'teacher';
    count: number;
    prefix: string;
    domain?: string;
    name_prefix?: string;
    start_number?: number;
    class_code?: string;
    weekly_token_limit?: number | null;
  }) => request<AdminBatchResult>('POST', '/admin/users/batch', payload),
  setQuota: (userId: string, weeklyTokenLimit: number | null) =>
    request<{ ok: boolean } & AiUsage>('POST', `/admin/users/${userId}/quota`, {
      weekly_token_limit: weeklyTokenLimit,
    }),
  resetPassword: (userId: string, password = '') =>
    request<{ ok: boolean; password: string }>('POST', `/admin/users/${userId}/password`, {
      password,
    }),
  deleteUser: (userId: string) => request<{ ok: boolean }>('DELETE', `/admin/users/${userId}`),
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

// ── LMS: classes, progress, quizzes ────────────────────────────────────────

export interface LmsClassTeaching {
  id: string;
  name: string;
  code: string;
  created_at: number;
  member_count: number;
}

export interface LmsClassJoined {
  id: string;
  name: string;
  teacher_name: string;
  joined_at: number;
}

export interface LmsQuizBest {
  best_score: number;
  total: number;
  attempts: number;
}

export interface LmsClassReportMember {
  id: string;
  name: string;
  email: string;
  joined_at: number;
  progress: string[];
  quiz: Record<string, LmsQuizBest>;
}

export interface LmsClassReport {
  id: string;
  name: string;
  code: string;
  created_at: number;
  members: LmsClassReportMember[];
}

export const lmsApi = {
  listClasses: () =>
    request<{ teaching: LmsClassTeaching[]; joined: LmsClassJoined[] }>('GET', '/lms/classes'),
  createClass: (name: string) =>
    request<{ id: string; name: string; code: string }>('POST', '/lms/classes', { name }),
  deleteClass: (id: string) => request<{ ok: boolean }>('DELETE', `/lms/classes/${id}`),
  joinClass: (code: string) =>
    request<{ id: string; name: string; teacher_name: string }>('POST', '/lms/classes/join', {
      code,
    }),
  classReport: (id: string) => request<LmsClassReport>('GET', `/lms/classes/${id}/report`),
  getProgress: () =>
    request<{ done: string[]; quiz: Record<string, LmsQuizBest> }>('GET', '/lms/progress'),
  setProgress: (lessonId: string, status: 'done' | 'reset' = 'done') =>
    request<{ ok: boolean }>('POST', '/lms/progress', { lesson_id: lessonId, status }),
  submitQuiz: (lessonId: string, score: number, total: number, answers: number[]) =>
    request<{ id: string }>('POST', '/lms/quiz', {
      lesson_id: lessonId,
      score,
      total,
      answers,
    }),
};

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
