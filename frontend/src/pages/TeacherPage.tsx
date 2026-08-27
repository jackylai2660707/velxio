/**
 * 教學管理 — teacher dashboard: create classes, hand out join codes, and
 * read the per-class report (lesson progress ✓ + best quiz score per
 * student, laid out per course). Requires a signed-in teacher account.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { useCloudStore } from '../cloud/useCloudStore';
import {
  lmsApi,
  type LmsAssignment,
  type LmsAssignmentSubmission,
  type LmsClassTeaching,
  type LmsClassReport,
} from '../cloud/cloudApi';
import { COURSES } from '../learn/courses';
import { lessonKey } from '../learn/types';
import './TeacherPage.css';

export const TeacherPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const sessionStatus = useCloudStore((s) => s.sessionStatus);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);

  const [classes, setClasses] = useState<LmsClassTeaching[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<LmsClassReport | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<LmsAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentNotice, setAssignmentNotice] = useState('');
  const [openComposer, setOpenComposer] = useState(false);
  const [selectedAssignment, setSelectedAssignment] = useState<LmsAssignment | null>(null);
  const [submissions, setSubmissions] = useState<LmsAssignmentSubmission[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState({
    title: '',
    instructions: '',
    lesson_id: '',
    assignment_type: 'project' as 'project' | 'quiz' | 'reflection',
    due_at: '',
    max_score: '100',
    auto_grade: true,
  });

  const copy = useMemo(
    () =>
      i18n.language.toLowerCase().startsWith('zh')
        ? {
            classroom: '課堂控制台',
            classroomHint: '建立任務、發布給全班，並在下課前掌握每一份提交。',
            assignments: '作業與活動',
            createAssignment: '建立作業',
            assignmentTitle: '作業標題',
            instructions: '學生說明',
            lesson: '連結課程（選填）',
            deadline: '截止時間',
            score: '滿分',
            automatic: '啟用自動評分',
            saveDraft: '儲存草稿',
            publish: '發布給學生',
            published: '已發布',
            draft: '草稿',
            due: '截止',
            noDeadline: '未設定截止時間',
            submissions: '提交',
            average: '平均',
            grading: '已評',
            review: '查看收件',
            noAssignments: '尚未建立活動。先建立一份可在課堂完成的作業。',
            noSubmissions: '暫時沒有學生提交。發布後，學生會在課程頁看到這份作業。',
            collection: '收件與評分',
            close: '關閉',
            submitted: '已交',
            notSubmitted: '未交',
            autoScored: '自動分數',
            manualScore: '教師分數',
            publishedNotice: '已發布；學生現在可以開始作答。',
            draftNotice: '草稿已建立。確認內容後再發布。',
            selectClass: '選擇一個班級以管理課堂活動。',
            allLessons: '不連結特定課程',
            assignmentType: '專題實作',
            project: '專題實作',
            quiz: '小測驗（可自動評分）',
            reflection: '文字反思',
          }
        : {
            classroom: 'Classroom control',
            classroomHint: 'Create activities, publish to the class, and see every submission before the bell.',
            assignments: 'Assignments & activities',
            createAssignment: 'Create assignment',
            assignmentTitle: 'Assignment title',
            instructions: 'Instructions for students',
            lesson: 'Linked lesson (optional)',
            deadline: 'Due date & time',
            score: 'Points possible',
            automatic: 'Enable automatic grading',
            saveDraft: 'Save draft',
            publish: 'Publish to students',
            published: 'Published',
            draft: 'Draft',
            due: 'Due',
            noDeadline: 'No deadline',
            submissions: 'submissions',
            average: 'Average',
            grading: 'graded',
            review: 'Review submissions',
            noAssignments: 'No activities yet. Create the first assignment your class can finish today.',
            noSubmissions: 'No student work yet. Once published, this activity appears on each student’s Courses page.',
            collection: 'Collection & grading',
            close: 'Close',
            submitted: 'Submitted',
            notSubmitted: 'Not submitted',
            autoScored: 'Auto score',
            manualScore: 'Teacher score',
            publishedNotice: 'Published — students can start now.',
            draftNotice: 'Draft created. Review it, then publish when ready.',
            selectClass: 'Choose a class to manage its activities.',
            allLessons: 'No linked lesson',
            assignmentType: 'Project build',
            project: 'Project build',
            quiz: 'Quiz (auto-graded)',
            reflection: 'Written reflection',
          },
    [i18n.language]
  );

  useSEO({
    title: t('teacher.seoTitle', '教學管理 — AI物聯網實驗室'),
    description: t(
      'teacher.seoDescription',
      '建立班級、發放班級代碼,即時掌握每位學生的課程進度與測驗成績。'
    ),
    url: '/teacher',
  });

  const isTeacher = user?.role === 'teacher';

  const refresh = useCallback(async () => {
    try {
      const r = await lmsApi.listClasses();
      setClasses(r.teaching);
      return r.teaching;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (isTeacher) void refresh();
  }, [isTeacher, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    lmsApi
      .classReport(selectedId)
      .then((r) => !cancelled && setReport(r))
      .catch(() => !cancelled && setReport(null));
    setAssignmentsLoading(true);
    lmsApi
      .listAssignments(selectedId)
      .then((r) => !cancelled && setAssignments(r.assignments))
      .catch(() => !cancelled && setAssignments([]))
      .finally(() => !cancelled && setAssignmentsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const createAssignment = async (publishImmediately = false) => {
    if (!selectedId || !assignmentForm.title.trim() || assignmentBusy) return;
    setAssignmentBusy(true);
    setAssignmentNotice('');
    try {
      const created = await lmsApi.createAssignment(selectedId, {
        title: assignmentForm.title.trim(),
        instructions: assignmentForm.instructions.trim(),
        lesson_id: assignmentForm.lesson_id || undefined,
        due_at: assignmentForm.due_at ? new Date(assignmentForm.due_at).toISOString() : undefined,
        max_score: Math.max(1, Number(assignmentForm.max_score) || 100),
        auto_grade: assignmentForm.auto_grade,
        assignment_type: assignmentForm.assignment_type,
      });
      const assignment = publishImmediately ? await lmsApi.publishAssignment(created.id) : created;
      setAssignments((current) => [assignment, ...current]);
      setAssignmentForm({ title: '', instructions: '', lesson_id: '', assignment_type: 'project', due_at: '', max_score: '100', auto_grade: true });
      setOpenComposer(false);
      setAssignmentNotice(publishImmediately ? copy.publishedNotice : copy.draftNotice);
    } finally {
      setAssignmentBusy(false);
    }
  };

  const publishAssignment = async (assignment: LmsAssignment) => {
    if (assignmentBusy || assignment.status === 'published') return;
    setAssignmentBusy(true);
    try {
      const published = await lmsApi.publishAssignment(assignment.id);
      setAssignments((current) => current.map((item) => (item.id === published.id ? published : item)));
      setAssignmentNotice(copy.publishedNotice);
    } finally {
      setAssignmentBusy(false);
    }
  };

  const reviewAssignment = async (assignment: LmsAssignment) => {
    setSelectedAssignment(assignment);
    setSubmissionsLoading(true);
    try {
      const result = await lmsApi.listAssignmentSubmissions(assignment.id);
      setSubmissions(result.submissions);
    } catch {
      setSubmissions([]);
    } finally {
      setSubmissionsLoading(false);
    }
  };

  const formatDate = (value: string | number | null | undefined) =>
    value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : copy.noDeadline;

  const createClass = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      await lmsApi.createClass(newName.trim());
      setNewName('');
      const list = await refresh();
      if (list.length > 0) setSelectedId(list[0].id);
    } finally {
      setBusy(false);
    }
  };

  const removeClass = async (id: string) => {
    if (!window.confirm(t('teacher.deleteConfirm', '確定要刪除這個班級嗎?學生的個人進度不會消失,但班級與名單會被移除。'))) return;
    await lmsApi.deleteClass(id).catch(() => {});
    if (selectedId === id) setSelectedId(null);
    await refresh();
  };

  const copyCode = (code: string) => {
    void navigator.clipboard?.writeText(code).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  };

  // ── Gates ────────────────────────────────────────────────
  if (sessionStatus !== 'signed-in') {
    return (
      <div className="teacher-page">
        <AppHeader />
        <div className="teacher-gate">
          <h1>{t('teacher.title', '教學管理')}</h1>
          <p>{t('teacher.needSignin', '請先登入教師帳號,才能建立與管理班級。')}</p>
          <button className="teacher-primary" onClick={() => setAuthModalOpen(true)}>
            {t('learn.signinCta', '登入 / 註冊')}
          </button>
        </div>
      </div>
    );
  }

  if (!isTeacher) {
    return (
      <div className="teacher-page">
        <AppHeader />
        <div className="teacher-gate">
          <h1>{t('teacher.title', '教學管理')}</h1>
          <p>
            {t(
              'teacher.needTeacherRole',
              '這個頁面需要教師帳號。你目前是學生身分 — 若你是老師,請用「教師」身分重新註冊一個帳號。'
            )}
          </p>
        </div>
      </div>
    );
  }

  // ── Dashboard ────────────────────────────────────────────
  return (
    <div className="teacher-page">
      <AppHeader />
      <div className="teacher-container">
        <section className="teacher-hero" aria-labelledby="teacher-page-title">
          <p className="teacher-eyebrow">{copy.classroom}</p>
          <h1 id="teacher-page-title">{t('teacher.title', '教學管理')}</h1>
          <p>{copy.classroomHint}</p>
        </section>

        <div className="teacher-create">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('teacher.namePlaceholder', '班級名稱,例如:八年級甲班')}
            maxLength={40}
            onKeyDown={(e) => e.key === 'Enter' && createClass()}
          />
          <button className="teacher-primary" onClick={createClass} disabled={busy || !newName.trim()}>
            {t('teacher.create', '建立班級')}
          </button>
        </div>

        {classes.length === 0 ? (
          <p className="teacher-empty">
            {t(
              'teacher.empty',
              '還沒有班級。建立第一個班級後,把班級代碼發給學生,他們在「課程」頁輸入代碼即可加入。'
            )}
          </p>
        ) : (
          <div className="teacher-class-list">
            {classes.map((c) => (
              <div
                key={c.id}
                className={'teacher-class-card' + (selectedId === c.id ? ' teacher-class-selected' : '')}
                role="button"
                tabIndex={0}
                aria-pressed={selectedId === c.id}
                onClick={() => setSelectedId(c.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedId(c.id);
                  }
                }}
              >
                <div className="teacher-class-name">{c.name}</div>
                <div className="teacher-class-code-row">
                  <span className="teacher-class-code">{c.code}</span>
                  <button
                    className="teacher-copy"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyCode(c.code);
                    }}
                  >
                    {copiedCode === c.code
                      ? t('teacher.copied', '已複製!')
                      : t('teacher.copy', '複製代碼')}
                  </button>
                </div>
                <div className="teacher-class-meta">
                  {t('teacher.members', '{{n}} 位學生', { n: c.member_count })}
                  <button
                    className="teacher-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeClass(c.id);
                    }}
                  >
                    {t('teacher.delete', '刪除')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedId ? (
          <section className="teacher-assignment-section" aria-labelledby="assignments-title">
            <div className="teacher-section-heading">
              <div>
                <p className="teacher-eyebrow">{copy.assignmentType}</p>
                <h2 id="assignments-title">{copy.assignments}</h2>
              </div>
              <button className="teacher-primary" onClick={() => setOpenComposer((value) => !value)}>
                {openComposer ? copy.close : copy.createAssignment}
              </button>
            </div>

            {assignmentNotice && <p className="teacher-notice" role="status">{assignmentNotice}</p>}

            {openComposer && (
              <form className="teacher-assignment-composer" onSubmit={(event) => { event.preventDefault(); void createAssignment(false); }}>
                <label>
                  <span>{copy.assignmentTitle}</span>
                  <input autoFocus value={assignmentForm.title} onChange={(event) => setAssignmentForm((current) => ({ ...current, title: event.target.value }))} maxLength={100} required />
                </label>
                <label className="teacher-composer-wide">
                  <span>{copy.instructions}</span>
                  <textarea value={assignmentForm.instructions} onChange={(event) => setAssignmentForm((current) => ({ ...current, instructions: event.target.value }))} rows={4} maxLength={3000} />
                </label>
                <label>
                  <span>{copy.assignmentType}</span>
                  <select value={assignmentForm.assignment_type} onChange={(event) => setAssignmentForm((current) => { const assignment_type = event.target.value as typeof current.assignment_type; return { ...current, assignment_type, auto_grade: assignment_type === 'quiz' }; })}>
                    <option value="project">{copy.project}</option>
                    <option value="quiz">{copy.quiz}</option>
                    <option value="reflection">{copy.reflection}</option>
                  </select>
                </label>
                <label>
                  <span>{copy.lesson}</span>
                  <select value={assignmentForm.lesson_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, lesson_id: event.target.value }))}>
                    <option value="">{copy.allLessons}</option>
                    {COURSES.flatMap((course) => course.lessons.map((lesson) => <option key={lessonKey(course.id, lesson.id)} value={lessonKey(course.id, lesson.id)}>{course.title} · {lesson.title}</option>))}
                  </select>
                </label>
                <label>
                  <span>{copy.deadline}</span>
                  <input type="datetime-local" value={assignmentForm.due_at} onChange={(event) => setAssignmentForm((current) => ({ ...current, due_at: event.target.value }))} />
                </label>
                <label>
                  <span>{copy.score}</span>
                  <input type="number" min="1" max="1000" value={assignmentForm.max_score} onChange={(event) => setAssignmentForm((current) => ({ ...current, max_score: event.target.value }))} />
                </label>
                <label className="teacher-check-label">
                  <input type="checkbox" checked={assignmentForm.auto_grade} disabled={assignmentForm.assignment_type !== 'quiz'} onChange={(event) => setAssignmentForm((current) => ({ ...current, auto_grade: event.target.checked }))} />
                  <span>{copy.automatic}</span>
                </label>
                <div className="teacher-composer-actions">
                  <button type="submit" className="teacher-secondary" disabled={assignmentBusy || !assignmentForm.title.trim()}>{copy.saveDraft}</button>
                  <button type="button" className="teacher-primary" disabled={assignmentBusy || !assignmentForm.title.trim()} onClick={() => void createAssignment(true)}>{copy.publish}</button>
                </div>
              </form>
            )}

            {assignmentsLoading ? (
              <p className="teacher-empty">Loading activities…</p>
            ) : assignments.length === 0 ? (
              <p className="teacher-empty">{copy.noAssignments}</p>
            ) : (
              <div className="teacher-assignment-grid">
                {assignments.map((assignment) => (
                  <article key={assignment.id} className="teacher-assignment-card">
                    <div className="teacher-assignment-topline">
                      <span className={'teacher-status teacher-status-' + assignment.status}>{assignment.status === 'published' ? copy.published : copy.draft}</span>
                      <span className="teacher-due">{copy.due}: {formatDate(assignment.due_at)}</span>
                    </div>
                    <h3>{assignment.title}</h3>
                    {assignment.instructions && <p>{assignment.instructions}</p>}
                    <dl className="teacher-assignment-metrics">
                      <div><dt>{copy.submissions}</dt><dd>{assignment.submission_count}</dd></div>
                      <div><dt>{copy.average}</dt><dd>{assignment.average_score === null ? '—' : `${assignment.average_score}/${assignment.max_score}`}</dd></div>
                      <div><dt>{copy.grading}</dt><dd>{assignment.graded_count}/{assignment.submission_count}</dd></div>
                    </dl>
                    <div className="teacher-assignment-actions">
                      {assignment.status !== 'published' && <button className="teacher-secondary" disabled={assignmentBusy} onClick={() => void publishAssignment(assignment)}>{copy.publish}</button>}
                      <button className="teacher-text-button" onClick={() => void reviewAssignment(assignment)}>{copy.review}</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
          <p className="teacher-empty teacher-select-class">{copy.selectClass}</p>
        )}

        {report && (
          <section className="teacher-report">
            <h2>
              {t('teacher.reportTitle', '「{{name}}」學習報表', { name: report.name })}
            </h2>
            {report.members.length === 0 ? (
              <p className="teacher-empty">
                {t('teacher.noMembers', '還沒有學生加入。把代碼 {{code}} 發給學生吧!', {
                  code: report.code,
                })}
              </p>
            ) : (
              COURSES.map((course) => (
                <div key={course.id} className="teacher-course-table">
                  <h3>
                    {course.emoji} {course.title}
                  </h3>
                  <div className="teacher-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('teacher.student', '學生')}</th>
                          <th>{t('teacher.progressCol', '進度')}</th>
                          {course.lessons.map((l, i) => (
                            <th key={l.id} title={l.title}>
                              {i + 1}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.members.map((m) => {
                          const doneSet = new Set(m.progress);
                          const doneCount = course.lessons.filter((l) =>
                            doneSet.has(lessonKey(course.id, l.id))
                          ).length;
                          return (
                            <tr key={m.id}>
                              <td className="teacher-student-cell" title={m.email}>
                                {m.name}
                              </td>
                              <td>
                                {doneCount}/{course.lessons.length}
                              </td>
                              {course.lessons.map((l) => {
                                const k = lessonKey(course.id, l.id);
                                const quiz = m.quiz[k];
                                const isDone = doneSet.has(k);
                                return (
                                  <td
                                    key={l.id}
                                    className={isDone ? 'teacher-cell-done' : ''}
                                    title={l.title}
                                  >
                                    {isDone ? '✓' : ''}
                                    {quiz && (
                                      <span className="teacher-cell-quiz">
                                        {quiz.best_score}/{quiz.total}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        {selectedAssignment && (
          <div className="teacher-dialog-backdrop" role="presentation" onMouseDown={() => setSelectedAssignment(null)}>
            <section className="teacher-submission-dialog" role="dialog" aria-modal="true" aria-labelledby="submission-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
              <div className="teacher-section-heading">
                <div><p className="teacher-eyebrow">{copy.collection}</p><h2 id="submission-dialog-title">{selectedAssignment.title}</h2></div>
                <button className="teacher-text-button" onClick={() => setSelectedAssignment(null)}>{copy.close}</button>
              </div>
              {submissionsLoading ? <p className="teacher-empty">Loading submissions…</p> : submissions.length === 0 ? <p className="teacher-empty">{copy.noSubmissions}</p> : (
                <div className="teacher-submission-list">
                  {submissions.map((submission) => {
                    const isSubmitted = submission.submitted ?? ['submitted', 'graded', 'returned'].includes(submission.status);
                    const autoScore = submission.auto_score ?? (selectedAssignment.auto_grade ? submission.score : null);
                    return <article className="teacher-submission-row" key={submission.id}>
                    <div><strong>{submission.student_name}</strong><span>{submission.student_email}</span></div>
                    <div><span>{isSubmitted ? copy.submitted : copy.notSubmitted}</span><small>{submission.submitted_at ? formatDate(submission.submitted_at) : '—'}</small></div>
                    <div><span>{copy.autoScored}</span><strong>{autoScore ?? '—'}</strong></div>
                    <div><span>{copy.manualScore}</span><strong>{submission.score ?? '—'}</strong></div>
                  </article>;
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
