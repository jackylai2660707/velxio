import { useMemo, useState } from 'react';
import type { LmsAssignment, LmsAssignmentSubmission } from '../../cloud/cloudApi';
import './SubmissionGrader.css';

type SubmissionFilter = 'all' | 'not_submitted' | 'late' | 'review' | 'returned';

type SubmissionGraderProps = {
  assignment: LmsAssignment;
  submissions: LmsAssignmentSubmission[];
  loading: boolean;
  onClose: () => void;
  language?: string;
  onGrade?: (submissionId: string, payload: { score: number | null; feedback: string; status: 'graded' | 'returned' }) => Promise<void>;
  loadAttempts?: (submissionId: string) => Promise<SubmissionAttempt[]>;
};

export type SubmissionAttempt = LmsAssignmentSubmission & { created_at?: string | number | null; attempt_no?: number | null };

const labels = {
  en: { collection: 'Collection & grading', close: 'Close', all: 'All', missing: 'Not submitted', late: 'Late', review: 'Needs review', returned: 'Returned', search: 'Search students', score: 'Score', feedback: 'Feedback for student', save: 'Save grade', return: 'Return for revision', history: 'Attempt history', noHistory: 'No earlier attempts', submitted: 'Submitted', pending: 'Awaiting review', points: 'points' },
  zh: { collection: '收件與評分', close: '關閉', all: '全部', missing: '未提交', late: '遲交', review: '待批改', returned: '退回重做', search: '搜尋學生', score: '分數', feedback: '給學生的回饋', save: '儲存評分', return: '退回重做', history: '提交紀錄', noHistory: '沒有較早的提交', submitted: '已提交', pending: '待批改', points: '分' },
};

const epochMs = (value: string | number | null | undefined) => {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
};

/** Teacher-side collection view. API mutation wiring stays intentionally at its parent boundary. */
export function SubmissionGrader({ assignment, submissions, loading, onClose, language, onGrade, loadAttempts }: SubmissionGraderProps) {
  const [filter, setFilter] = useState<SubmissionFilter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, SubmissionAttempt[]>>({});
  const [drafts, setDrafts] = useState<Record<string, { score: string; feedback: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const zh = (language ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')).toLowerCase().startsWith('zh');
  const copy = zh ? labels.zh : labels.en;
  const visibleSubmissions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return submissions.filter((item) => {
      const status = String(item.status || '').toLowerCase();
      const late = Boolean((item as LmsAssignmentSubmission & { is_late?: boolean }).is_late) || ((epochMs(assignment.due_at) ?? Infinity) < (epochMs(item.submitted_at) ?? -Infinity));
      if (filter === 'late' && !late) return false;
      if (filter === 'review' && !['submitted', 'late'].includes(status)) return false;
      if (filter === 'returned' && status !== 'returned') return false;
      if (filter === 'not_submitted' && item.submitted) return false;
      return !q || `${item.student_name} ${item.student_email}`.toLowerCase().includes(q);
    });
  }, [assignment.due_at, filter, query, submissions]);

  const toggleHistory = async (submissionId: string) => {
    if (expanded === submissionId) { setExpanded(null); return; }
    setExpanded(submissionId);
    if (!loadAttempts || history[submissionId]) return;
    const attempts = await loadAttempts(submissionId).catch(() => []);
    setHistory((current) => ({ ...current, [submissionId]: attempts }));
  };

  const draftFor = (item: LmsAssignmentSubmission) => drafts[item.id] ?? { score: item.score == null ? '' : String(item.score), feedback: item.feedback ?? '' };
  const save = async (item: LmsAssignmentSubmission, status: 'graded' | 'returned') => {
    if (!onGrade || saving) return;
    const draft = draftFor(item);
    const score = draft.score.trim() === '' ? null : Number(draft.score);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > assignment.max_score)) return;
    setSaving(item.id);
    try { await onGrade(item.id, { score, feedback: draft.feedback, status }); } finally { setSaving(null); }
  };

  return (
    <section className="submission-grader" aria-label="Submission collection">
      <header className="submission-grader__header">
        <div>
          <p className="submission-grader__eyebrow">{copy.collection}</p>
          <h3>{assignment.title}</h3>
        </div>
        <button className="submission-grader__close" type="button" onClick={onClose}>{copy.close}</button>
      </header>
      <label className="submission-grader__search"><span className="sr-only">{copy.search}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} /></label>
      <nav className="submission-grader__filters" aria-label="Submission status filter">
        {(['all', 'not_submitted', 'late', 'review', 'returned'] as const).map((value) => (
          <button
            className={filter === value ? 'is-active' : ''}
            key={value}
            type="button"
            onClick={() => setFilter(value)}
          >
            {value === 'not_submitted' ? copy.missing : copy[value]}
          </button>
        ))}
      </nav>
      {loading ? <p className="submission-grader__empty">Loading submissions…</p> : null}
      {!loading && visibleSubmissions.length === 0 ? (
        <p className="submission-grader__empty">{filter === 'not_submitted' ? copy.noHistory : 'No student work has arrived yet.'}</p>
      ) : null}
      <div className="submission-grader__list">
        {visibleSubmissions.map((item) => {
          const draft = draftFor(item);
          const isReturned = item.status === 'returned';
          return <article className="submission-grader__row" key={item.id}>
            <div className="submission-grader__student"><strong>{item.student_name}</strong><span>{item.student_email}</span><small>{epochMs(item.submitted_at) != null ? new Date(epochMs(item.submitted_at) as number).toLocaleString() : copy.pending}</small></div>
            <span className={`submission-grader__badge submission-grader__badge--${isReturned ? 'returned' : item.status}`}>{isReturned ? copy.returned : item.submitted ? copy.submitted : copy.pending}</span>
            <div className="submission-grader__score"><label>{copy.score}<input type="number" min="0" max={assignment.max_score} value={draft.score} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, score: event.target.value } }))} /></label><span>/ {assignment.max_score} {copy.points}</span></div>
            <label className="submission-grader__feedback"><span>{copy.feedback}</span><textarea rows={2} value={draft.feedback} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, feedback: event.target.value } }))} /></label>
            <div className="submission-grader__actions"><button type="button" disabled={!onGrade || saving === item.id} onClick={() => void save(item, 'graded')}>{saving === item.id ? '…' : copy.save}</button><button type="button" className="is-return" disabled={!onGrade || saving === item.id} onClick={() => void save(item, 'returned')}>{copy.return}</button><button type="button" className="is-history" onClick={() => void toggleHistory(item.id)}>{copy.history}</button></div>
            {expanded === item.id ? <div className="submission-grader__history"><strong>{copy.history}</strong>{history[item.id]?.length ? history[item.id].map((attempt) => <div key={attempt.id}><span>#{attempt.attempt_no ?? '—'}</span><span>{epochMs(attempt.submitted_at) != null ? new Date(epochMs(attempt.submitted_at) as number).toLocaleString() : '—'}</span><span>{attempt.score ?? '—'} / {assignment.max_score}</span></div>) : <p>{loadAttempts ? copy.noHistory : 'History endpoint unavailable.'}</p>}</div> : null}
          </article>;
        })}
      </div>
    </section>
  );
}
