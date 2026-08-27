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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

/** A question published as part of a teacher assignment.  The server never
 * sends the answer key to students; `answer` is therefore intentionally
 * optional even though the built-in lesson quiz type requires it. */
export interface LmsAssignmentQuestion {
  id: string;
  question: string;
  options: string[];
  type?: 'single' | 'multiple' | 'true_false' | 'short' | 'long' | 'code' | 'circuit' | string;
  answer?: number | number[] | string;
  points?: number;
  explanation?: string;
  rubric?: string;
}

export type LmsAssignmentType = 'quiz' | 'project' | 'reflection' | 'mixed' | string;

export type LmsAssignmentStatus =
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'graded'
  | 'late'
  | string;

export interface LmsSubmission {
  id: string;
  assignment_id?: string;
  status: LmsAssignmentStatus;
  score: number | null;
  max_score: number;
  feedback: string | null;
  submitted_at: number | null;
  graded_at?: number | null;
  attempt_no?: number;
  content?: string;
  answers?: unknown;
  started_at?: number | null;
  expires_at?: number | null;
  saved_at?: number | null;
  attempt_count?: number;
  is_late?: boolean;
  opens_at?: number | null;
  closes_at?: number | null;
  time_limit?: number | null;
  max_attempts?: number;
  late_policy?: 'reject' | 'allow' | 'flag' | string;
}

/** Immutable snapshot of one final assignment submission.  Timed exams also
 * expose the current mutable draft using this shape with status
 * ``in_progress``. */
export interface LmsSubmissionAttempt extends LmsSubmission {
  id: string;
  assignment_id: string;
  student_id: string;
  student_name: string;
  student_email: string;
  attempt_id?: string;
  submission_id?: string;
  attempt_no: number;
  created_at?: number;
  graded_at?: number | null;
}

export interface LmsAssignment {
  id: string;
  class_id: string;
  class_name?: string;
  title: string;
  description?: string;
  instructions?: string;
  lesson_id?: string | null;
  assignment_type: LmsAssignmentType;
  /** Assignment quiz questions. Answer keys are stripped for students. */
  quiz?: LmsAssignmentQuestion[] | { questions?: LmsAssignmentQuestion[] } | null;
  project_template?: Record<string, unknown> | string | null;
  due_at?: number | null;
  max_score: number;
  auto_grade: boolean;
  status?: string;
  published_at?: number | null;
  created_at: number;
  updated_at?: number;
  submission?: LmsSubmission | null;
  /** Teacher dashboard aggregates; omitted for student-scoped responses. */
  submission_count?: number;
  graded_count?: number;
  average_score?: number | null;
  rubric?: string | null;
  opens_at?: string | number | null;
  closes_at?: string | number | null;
  time_limit?: number | null;
  max_attempts?: number | null;
  late_policy?: 'reject' | 'allow' | 'flag' | string;
  window_status?: 'upcoming' | 'open' | 'closed' | string;
  duration_minutes?: number | null;
  attempts_allowed?: number | null;
  allow_late?: boolean;
  show_score_immediately?: boolean;
}

export interface LmsAssignmentSubmission {
  id: string;
  assignment_id: string;
  student_id: string;
  student_name: string;
  student_email: string;
  submitted?: boolean;
  submitted_at: string | number | null;
  status: LmsAssignmentStatus;
  score: number | null;
  auto_score?: number | null;
  feedback: string | null;
}

export interface LmsAssignmentCreate {
  title: string;
  description?: string;
  instructions?: string;
  lesson_id?: string;
  project_template?: Record<string, unknown> | string;
  assignment_type?: LmsAssignmentType;
  /** Optional quiz manifest; answer keys stay teacher-side on the server. */
  quiz?: Array<{
    id: string;
    question: string;
    options: string[];
    answer: number | number[] | string;
    type?: string;
    points?: number;
    explanation?: string;
    rubric?: string;
  }>;
  due_at?: string;
  max_score?: number;
  auto_grade?: boolean;
  rubric?: string;
  opens_at?: string;
  closes_at?: string;
  time_limit?: number;
  max_attempts?: number;
  late_policy?: 'reject' | 'allow' | 'flag' | string;
  duration_minutes?: number;
  attempts_allowed?: number;
  allow_late?: boolean;
  show_score_immediately?: boolean;
}

export interface LmsAssignmentSubmitPayload {
  answers?: unknown[];
  content?: string;
  /** A .vlx-compatible project snapshot when the student attaches work. */
  project_data?: VlxPayload | Record<string, unknown>;
  files?: Record<string, string>;
  /** False saves a draft; true creates a final submission. */
  submit?: boolean;
}

export interface LmsAssignmentSubmitResult {
  submission: LmsSubmission;
  auto_graded: boolean;
}

export interface LmsAttemptPayload {
  answers?: unknown;
  content?: string;
  project_data?: VlxPayload | Record<string, unknown>;
  files?: Record<string, string>;
}

export const lmsApi = {
  listClasses: () =>
    request<{ teaching: LmsClassTeaching[]; joined: LmsClassJoined[] }>('GET', '/lms/classes'),
  teacherDashboard: (params?: { classIds?: string[]; status?: string; sort?: string; q?: string }) => {
    const query = new URLSearchParams();
    if (params?.classIds?.length) query.set('class_ids', params.classIds.join(','));
    if (params?.status) query.set('status', params.status);
    if (params?.sort) query.set('sort', params.sort);
    if (params?.q) query.set('q', params.q);
    return request<{
      classes: LmsClassTeaching[];
      students?: Array<{ id: string; name: string; email: string; class_ids?: string[]; class_names?: string[]; completion_rate?: number; average_score: number | null; late_count?: number; submitted_count?: number; assignment_count?: number }>;
      assignments?: LmsAssignment[];
      totals?: { students: number; assignments: number; submissions: number; completion_rate: number };
    }>('GET', `/lms/teacher/dashboard${query.toString() ? `?${query.toString()}` : ''}`);
  },
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
  /** Published assignments for all classes the current student joined. */
  listAssignments: (classId?: string) =>
    request<{ assignments: LmsAssignment[] }>(
      'GET',
      classId ? `/lms/classes/${encodeURIComponent(classId)}/assignments` : '/lms/assignments',
    ),
  createAssignment: (classId: string, payload: LmsAssignmentCreate) =>
    request<LmsAssignment>(
      'POST',
      `/lms/classes/${encodeURIComponent(classId)}/assignments`,
      payload,
    ),
  publishAssignment: (assignmentId: string) =>
    request<LmsAssignment>('POST', `/lms/assignments/${encodeURIComponent(assignmentId)}/publish`),
  listAssignmentSubmissions: (assignmentId: string) =>
    request<{ submissions: LmsAssignmentSubmission[] }>(
      'GET',
      `/lms/assignments/${encodeURIComponent(assignmentId)}/submissions`,
    ),
  /** A teacher can either finalise a mark or return work for revision. */
  gradeSubmission: (
    submissionId: string,
    payload: { score: number | null; feedback: string; status: 'graded' | 'returned' },
  ) =>
    request<{ submission: LmsAssignmentSubmission }>(
      'PATCH',
      `/lms/submissions/${encodeURIComponent(submissionId)}/grade`,
      payload,
    ),
  listSubmissionAttempts: (submissionId: string) =>
    request<{ attempts: LmsSubmissionAttempt[] }>(
      'GET',
      `/lms/submissions/${encodeURIComponent(submissionId)}/attempts`,
    ),
  /** Download teacher-scoped submissions as a CSV (optionally filtered by class). */
  exportAssignmentsCsv: (classId?: string) => {
    const query = classId ? `?class_ids=${encodeURIComponent(classId)}` : '';
    const token = getToken();
    const base = getApiBase();
    return fetch(`${base}/lms/teacher/export.csv${query}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).then(async (response) => {
      if (!response.ok) throw new CloudApiError(response.status, (await response.text()) || 'Export failed');
      return response.blob();
    });
  },
  getAssignment: (assignmentId: string) =>
    request<LmsAssignment>('GET', `/lms/assignments/${encodeURIComponent(assignmentId)}`),
  submitAssignment: (assignmentId: string, payload: LmsAssignmentSubmitPayload) =>
    request<LmsAssignmentSubmitResult>(
      'POST',
      `/lms/assignments/${encodeURIComponent(assignmentId)}/submissions`,
      payload,
    ),
  getAssignmentSubmission: (assignmentId: string) =>
    request<{ submission: LmsSubmission | null }>(
      'GET',
      `/lms/assignments/${encodeURIComponent(assignmentId)}/submission`,
    ),
  /** Student attempt history, including an in-progress timed draft. */
  getAttempts: (assignmentId: string) =>
    request<{ attempts: LmsSubmissionAttempt[]; history?: LmsSubmissionAttempt[]; server_time?: number }>(
      'GET',
      `/lms/assignments/${encodeURIComponent(assignmentId)}/attempts`,
    ),
  /** Start or resume the student's current timed attempt. */
  startAttempt: (assignmentId: string) =>
    request<{ attempt: LmsSubmissionAttempt; server_time?: number }>(
      'POST',
      `/lms/assignments/${encodeURIComponent(assignmentId)}/attempts`,
    ),
  /** Autosave the student's current attempt without consuming a retry. */
  saveAttempt: (attemptId: string, payload: LmsAttemptPayload) =>
    request<{ attempt: LmsSubmissionAttempt; server_time?: number }>(
      'PATCH',
      `/lms/attempts/${encodeURIComponent(attemptId)}`,
      payload,
    ),
  /** Finalise a timed attempt and create an immutable history snapshot. */
  submitAttempt: (attemptId: string, payload: LmsAttemptPayload) =>
    request<{ submission: LmsSubmissionAttempt; server_time?: number }>(
      'POST',
      `/lms/attempts/${encodeURIComponent(attemptId)}/submit`,
      payload,
    ),
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
