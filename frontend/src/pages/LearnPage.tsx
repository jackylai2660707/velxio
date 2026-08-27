/**
 * 課程總覽 — course cards with per-lesson progress, plus the student's
 * class-membership widget (join by code). Anonymous visitors can take
 * every course; progress lives in localStorage until they sign in.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import { COURSES, courseLessonKeys } from '../learn/courses';
import { lessonKey } from '../learn/types';
import { useLearnStore } from '../learn/useLearnStore';
import { useCloudStore } from '../cloud/useCloudStore';
import { buildVlxPayload } from '../utils/vlxFile';
import {
  lmsApi,
  type LmsAssignment,
  type LmsAssignmentQuestion,
  type LmsClassJoined,
  type LmsSubmission,
  CloudApiError,
} from '../cloud/cloudApi';
import './LearnPage.css';

const JoinClassWidget: React.FC<{ onJoined?: () => void }> = ({ onJoined }) => {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const [classes, setClasses] = useState<LmsClassJoined[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    lmsApi
      .listClasses()
      .then((r) => setClasses(r.joined))
      .catch(() => {});
  }, [user]);

  if (!user) return null;

  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const cls = await lmsApi.joinClass(code);
      setCode('');
      setMessage(t('learn.class.joinedMsg', '已加入「{{name}}」!', { name: cls.name }));
      const r = await lmsApi.listClasses();
      setClasses(r.joined);
      onJoined?.();
    } catch (err) {
      setMessage(
        err instanceof CloudApiError && err.status === 404
          ? t('learn.class.unknownCode', '找不到這個班級代碼,請跟老師確認。')
          : t('learn.class.joinFailed', '加入失敗,請稍後再試。'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="learn-class-widget">
      <div className="learn-class-joined">
        <span className="learn-class-label">{t('learn.class.mine', '我的班級')}:</span>
        {classes.length === 0 ? (
          <span className="learn-class-none">{t('learn.class.none', '尚未加入任何班級')}</span>
        ) : (
          classes.map((c) => (
            <span key={c.id} className="learn-class-chip" title={c.teacher_name}>
              {c.name}
            </span>
          ))
        )}
      </div>
      <div className="learn-class-join">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t('learn.class.codePlaceholder', '輸入班級代碼')}
          maxLength={8}
          onKeyDown={(e) => e.key === 'Enter' && join()}
        />
        <button onClick={join} disabled={busy || !code.trim()}>
          {t('learn.class.join', '加入班級')}
        </button>
      </div>
      {message && <div className="learn-class-message">{message}</div>}
    </div>
  );
};

function assignmentQuestions(quiz: LmsAssignment['quiz']): LmsAssignmentQuestion[] {
  if (Array.isArray(quiz)) return quiz;
  if (quiz && typeof quiz === 'object' && 'questions' in quiz) {
    const questions = (quiz as { questions?: unknown }).questions;
    return Array.isArray(questions) ? (questions as LmsAssignmentQuestion[]) : [];
  }
  return [];
}

function assignmentDate(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

function assignmentDateTime(timestamp: number | null | undefined): string | null {
  const millis = assignmentDueTime(timestamp);
  if (millis === null) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function assignmentDueTime(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return Number.isFinite(millis) ? millis : null;
}

function assignmentStatusLabel(
  status: string | undefined,
  t: (key: string, fallback: string) => string,
): string {
  switch (status) {
    case 'graded':
      return t('learn.assignment.statusGraded', '已評分 / Graded');
    case 'submitted':
      return t('learn.assignment.statusSubmitted', '已繳交 / Submitted');
    case 'late':
      return t('learn.assignment.statusLate', '逾期 / Late');
    case 'in_progress':
      return t('learn.assignment.statusDraft', '草稿 / Draft');
    default:
      return t('learn.assignment.statusAssigned', '待完成 / Assigned');
  }
}

interface AssignmentCardProps {
  assignment: LmsAssignment;
  onUpdated: (submission: LmsSubmission) => void;
}

/** One student-facing assignment. It deliberately keeps the submit action
 * behind an explicit button and can attach the current .vlx workspace. */
const AssignmentCard: React.FC<AssignmentCardProps> = ({ assignment, onUpdated }) => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();
  const recordSubmission = useLearnStore((s) => s.recordAssignmentSubmission);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<LmsAssignment>(assignment);
  const [content, setContent] = useState(assignment.submission?.content ?? '');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [attachProject, setAttachProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<LmsSubmission | null>(assignment.submission ?? null);
  const [now, setNow] = useState(() => Date.now());

  const questions = assignmentQuestions(detail.quiz);
  const allAnswered = questions.every((q) => answers[q.id] !== undefined);
  const effectiveSubmission = submitted ?? detail.submission;
  const due = assignmentDate(detail.due_at);
  const dueTime = assignmentDueTime(detail.due_at);
  const isPastDue = dueTime !== null && now > dueTime;
  const attemptLabel = effectiveSubmission?.attempt_no
    ? t('learn.assignment.attempt', '第 {{n}} 次提交 / Attempt {{n}}', { n: effectiveSubmission.attempt_no })
    : null;

  useEffect(() => {
    if (!dueTime) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [dueTime]);

  useEffect(() => {
    setDetail(assignment);
    if (assignment.submission) setSubmitted(assignment.submission);
  }, [assignment]);

  const openDetail = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setError(null);
    setOpen(true);
    try {
      const next = await lmsApi.getAssignment(assignment.id);
      setDetail(next);
      if (next.submission) {
        setSubmitted(next.submission);
        setContent(next.submission.content ?? '');
      }
    } catch {
      // The list response is already sufficient to work offline or while a
      // self-hosted instance is upgrading; keep showing it when detail fails.
    }
  };

  const submit = async () => {
    if (busy || isPastDue || (questions.length > 0 && !allAnswered)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await lmsApi.submitAssignment(assignment.id, {
        answers: questions.length ? questions.map((q) => answers[q.id] ?? -1) : undefined,
        content: content.trim() || undefined,
        project_data: attachProject ? buildVlxPayload() : undefined,
        submit: true,
      });
      setSubmitted(result.submission);
      setDetail((current) => ({ ...current, submission: result.submission }));
      recordSubmission(assignment.id, result.submission);
      onUpdated(result.submission);
    } catch (err) {
      setError(
        err instanceof CloudApiError
          ? err.message
          : t('learn.assignment.submitFailed', '繳交失敗,請稍後再試。 / Submission failed.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="learn-assignment-card">
      <div className="learn-assignment-head">
        <div>
          <h3>{detail.title}</h3>
          <div className="learn-assignment-meta">
            {detail.class_name && <span>{detail.class_name}</span>}
            <span>{assignmentStatusLabel(effectiveSubmission?.status ?? detail.status, t)}</span>
            {due && (
              <span>
                {t('learn.assignment.due', '截止 / Due')}: {due}
              </span>
            )}
            {attemptLabel && <span>{attemptLabel}</span>}
            {effectiveSubmission?.submitted_at && (
              <span>
                {t('learn.assignment.submittedAt', '提交 / Submitted')}: {assignmentDateTime(effectiveSubmission.submitted_at) ?? '—'}
              </span>
            )}
          </div>
        </div>
        {effectiveSubmission?.score !== null && effectiveSubmission?.score !== undefined && (
          <span className="learn-assignment-score">
            {effectiveSubmission.score}/{effectiveSubmission.max_score ?? detail.max_score}
          </span>
        )}
      </div>

      {detail.description && <p className="learn-assignment-description">{detail.description}</p>}
      <button className="learn-assignment-toggle" onClick={openDetail} aria-expanded={open}>
        {open
          ? t('learn.assignment.hide', '收起作業 / Hide assignment')
          : t('learn.assignment.open', '查看作業 / View assignment')}
      </button>

      {open && (
        <div className="learn-assignment-body">
          {detail.instructions && (
            <div className="learn-assignment-instructions">{detail.instructions}</div>
          )}

          {detail.lesson_id && (
            <Link
              className="learn-assignment-lesson-link"
              to={localize(localizeLessonHref(detail.lesson_id))}
            >
              📘 {t('learn.assignment.openLesson', '開啟相關課程 / Open lesson')}
            </Link>
          )}

          {questions.length > 0 && (
            <div className="learn-assignment-questions">
              <h4>{t('learn.assignment.questions', '作業題目 / Questions')}</h4>
              {questions.map((question, index) => (
                <fieldset key={question.id} className="learn-assignment-question">
                  <legend>
                    {index + 1}. {question.question}
                  </legend>
                  {question.options.map((option, optionIndex) => (
                    <label key={optionIndex}>
                      <input
                        type="radio"
                        name={`${assignment.id}-${question.id}`}
                        checked={answers[question.id] === optionIndex}
                        onChange={() =>
                          setAnswers((current) => ({ ...current, [question.id]: optionIndex }))
                        }
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          )}

          <label className="learn-assignment-content-label">
            <span>{t('learn.assignment.response', '文字回覆 / Written response')}</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={4}
              placeholder={t(
                'learn.assignment.responsePlaceholder',
                '寫下你的觀察、答案或測試結果… / Describe your work…',
              )}
            />
          </label>

          <label className="learn-assignment-attach">
            <input
              type="checkbox"
              checked={attachProject}
              onChange={(event) => setAttachProject(event.target.checked)}
            />
            <span>
              {t(
                'learn.assignment.attachProject',
                '附加目前工作區 (.vlx) / Attach current workspace',
              )}
            </span>
          </label>

          {effectiveSubmission?.feedback && (
            <div className="learn-assignment-feedback">
              <strong>{t('learn.assignment.feedback', '老師回饋 / Feedback')}</strong>
              <p>{effectiveSubmission.feedback}</p>
            </div>
          )}
          {isPastDue && !effectiveSubmission && (
            <p className="learn-assignment-deadline" role="status">
              {t('learn.assignment.closed', '已截止，無法再提交 / Closed — submissions are no longer accepted.')}
            </p>
          )}
          {error && (
            <p className="learn-assignment-error" role="alert">
              {error}
            </p>
          )}
          <div className="learn-assignment-actions">
            <button
              className="learn-assignment-submit"
              onClick={submit}
              disabled={busy || isPastDue || (questions.length > 0 && !allAnswered)}
            >
              {busy
                ? t('learn.assignment.submitting', '評分中… / Submitting…')
                : effectiveSubmission
                  ? t('learn.assignment.resubmit', '修改後重新提交 / Resubmit revision')
                  : t('learn.assignment.submit', '繳交並自動評分 / Submit & auto-grade')}
            </button>
            {questions.length > 0 && !allAnswered && (
              <span className="learn-assignment-hint">
                {t('learn.assignment.answerAll', '請先回答所有題目 / Answer all questions first')}
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  );
};

// Assignment lesson ids are canonical course/lesson keys. Keep malformed or
// teacher-authored ids harmless: those simply return the course landing page.
function localizeLessonHref(lessonId: string): string {
  const parts = lessonId.split('/');
  return parts.length === 2 ? `/learn/${parts[0]}/${parts[1]}` : '/learn';
}

const AssignmentSection: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const [assignments, setAssignments] = useState<LmsAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setAssignments([]);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const response = await lmsApi.listAssignments();
      setAssignments(
        response.assignments.map((assignment) => ({
          ...assignment,
          // The server is authoritative. Assignment ids can outlive a
          // browser session, so never overlay another account's local cache.
          submission: assignment.submission ?? null,
        })),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  if (!user) return null;

  return (
    <section className="learn-assignments" aria-labelledby="learn-assignments-title">
      <div className="learn-assignments-title-row">
        <div>
          <h2 id="learn-assignments-title">
            📚 {t('learn.assignment.title', '我的作業 / My assignments')}
          </h2>
          <p>
            {t(
              'learn.assignment.subtitle',
              '老師發布的作業會出現在這裡,提交後立即看到自動評分。 / Published class work appears here with instant grading.',
            )}
          </p>
        </div>
        <button
          className="learn-assignment-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? '…' : t('learn.assignment.refresh', '重新整理 / Refresh')}
        </button>
      </div>
      {error && (
        <p className="learn-assignment-error" role="alert">
          {t(
            'learn.assignment.loadFailed',
            '作業載入失敗,請稍後再試。 / Could not load assignments.',
          )}
        </p>
      )}
      {!loading && !error && assignments.length === 0 && (
        <p className="learn-assignment-empty">
          {t(
            'learn.assignment.empty',
            '目前沒有待完成的作業。加入班級後,老師發布的作業會顯示在這裡。 / No assignments yet. Join a class to receive work.',
          )}
        </p>
      )}
      <div className="learn-assignment-list">
        {assignments.map((assignment) => (
          <AssignmentCard
            key={assignment.id}
            assignment={assignment}
            onUpdated={(submission) =>
              setAssignments((current) =>
                current.map((item) => (item.id === assignment.id ? { ...item, submission } : item)),
              )
            }
          />
        ))}
      </div>
    </section>
  );
};

export const LearnPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();
  const user = useCloudStore((s) => s.user);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);
  const done = useLearnStore((s) => s.done);
  const quizBest = useLearnStore((s) => s.quizBest);
  const [assignmentRefresh, setAssignmentRefresh] = useState(0);

  useSEO({
    title: t('learn.seoTitle', '課程 — AI物聯網實驗室'),
    description: t(
      'learn.seoDescription',
      'Arduino 入門與 ESP32 物聯網互動課程:原理解說、一鍵載入電路範例、動手挑戰與選擇題測驗。',
    ),
    url: '/learn',
  });

  return (
    <div className="learn-page">
      <AppHeader />
      <div className="learn-container">
        <h1>{t('learn.title', '課程')}</h1>
        <p className="learn-subtitle">
          {t(
            'learn.subtitle',
            '每一課都能直接在瀏覽器裡動手做:讀原理、開範例電路、完成挑戰,再用小測驗確認自己學會了。',
          )}
        </p>

        {!user && (
          <div className="learn-signin-hint">
            {t(
              'learn.signinHint',
              '進度會先存在這台電腦。登入後可跨裝置同步,老師也能在班級報表看到你的進度。',
            )}{' '}
            <button onClick={() => setAuthModalOpen(true)}>
              {t('learn.signinCta', '登入 / 註冊')}
            </button>
          </div>
        )}

        <JoinClassWidget onJoined={() => setAssignmentRefresh((value) => value + 1)} />

        <AssignmentSection refreshKey={assignmentRefresh} />

        {COURSES.map((course) => {
          const keys = courseLessonKeys(course);
          const doneCount = keys.filter((k) => done[k]).length;
          const pct = keys.length ? Math.round((doneCount / keys.length) * 100) : 0;
          return (
            <section key={course.id} className="learn-course-card">
              <div className="learn-course-head">
                <span className="learn-course-emoji" aria-hidden>
                  {course.emoji}
                </span>
                <div className="learn-course-titles">
                  <h2>{course.title}</h2>
                  <p>{course.description}</p>
                </div>
                <span className="learn-course-level">{course.level}</span>
              </div>

              <div className="learn-progress">
                <div className="learn-progress-bar">
                  <div className="learn-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="learn-progress-text">
                  {t('learn.progress', '{{done}}/{{total}} 課完成', {
                    done: doneCount,
                    total: keys.length,
                  })}
                </span>
              </div>

              <ol className="learn-lesson-list">
                {course.lessons.map((lesson, i) => {
                  const key = lessonKey(course.id, lesson.id);
                  const isDone = !!done[key];
                  const best = quizBest[key];
                  return (
                    <li key={lesson.id}>
                      <Link
                        to={localize(`/learn/${course.id}/${lesson.id}`)}
                        className={'learn-lesson-row' + (isDone ? ' learn-lesson-done' : '')}
                      >
                        <span className="learn-lesson-status" aria-hidden>
                          {isDone ? '✓' : i + 1}
                        </span>
                        <span className="learn-lesson-title">{lesson.title}</span>
                        <span className="learn-lesson-meta">
                          {best && (
                            <span className="learn-lesson-quiz">
                              📝 {best.best_score}/{best.total}
                            </span>
                          )}
                          <span className="learn-lesson-minutes">
                            {t('learn.minutes', '{{m}} 分鐘', { m: lesson.minutes })}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
};
