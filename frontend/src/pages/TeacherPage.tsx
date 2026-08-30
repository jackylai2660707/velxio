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
import { COURSES, getLesson } from '../learn/courses';
import { lessonKey } from '../learn/types';
import { SubmissionGrader } from '../components/teacher/SubmissionGrader';
import {
  ExamBuilder,
  type ExamQuestionDraft,
  type ExamSettingsDraft,
} from '../components/teacher/ExamBuilder';
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
    opens_at: '',
    duration_minutes: '',
    attempts_allowed: '',
    allow_late: false,
    show_score_immediately: true,
  });
  const [examQuestions, setExamQuestions] = useState<ExamQuestionDraft[]>([]);
  const [classQuery, setClassQuery] = useState('');
  const [classSort, setClassSort] = useState<'name' | 'students' | 'recent'>('recent');
  const [classFilter, setClassFilter] = useState<'all' | 'withStudents' | 'empty'>('all');
  const [exportBusy, setExportBusy] = useState(false);
  const [dashboardStudents, setDashboardStudents] = useState<Array<{
    id: string;
    name: string;
    email: string;
    class_ids?: string[];
    class_names?: string[];
    completion_rate?: number;
    average_score: number | null;
    late_count?: number;
    submitted_count?: number;
    assignment_count?: number;
  }>>([]);

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
            quiz: '考試 / 小測驗（可自動評分）',
            reflection: '文字反思',
            overview: '班級總覽',
            classesCount: '個班級',
            studentsTotal: '位學生',
            classSearch: '搜尋班級名稱或代碼',
            allClasses: '全部班級',
            withStudents: '有學生',
            emptyClasses: '尚未加入學生',
            sortRecent: '最近建立',
            sortName: '名稱排序',
            sortStudents: '學生人數',
            exportCsv: '匯出全部成績 CSV',
            exportJson: '匯出全部成績 JSON',
            exportClassCsv: '匯出本班 CSV',
            exportClassJson: '匯出本班 JSON',
            exportAssignmentCsv: '匯出此作業 CSV',
            exportAssignmentJson: '匯出此作業 JSON',
            exporting: '正在匯出…',
            exportSuccess: '成績檔案已下載',
            exportFailed: '匯出失敗，請稍後再試',
            window: '開放',
            duration: '限時',
            attempts: '最多提交',
          }
        : {
            classroom: 'Classroom control',
            classroomHint:
              'Create activities, publish to the class, and see every submission before the bell.',
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
            noAssignments:
              'No activities yet. Create the first assignment your class can finish today.',
            noSubmissions:
              'No student work yet. Once published, this activity appears on each student’s Courses page.',
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
            quiz: 'Exam / quiz (auto-graded)',
            reflection: 'Written reflection',
            overview: 'Class overview',
            classesCount: 'classes',
            studentsTotal: 'students',
            classSearch: 'Search class name or code',
            allClasses: 'All classes',
            withStudents: 'With students',
            emptyClasses: 'No students yet',
            sortRecent: 'Recently created',
            sortName: 'Name',
            sortStudents: 'Student count',
            exportCsv: 'Export all grades CSV',
            exportJson: 'Export all grades JSON',
            exportClassCsv: 'Export class CSV',
            exportClassJson: 'Export class JSON',
            exportAssignmentCsv: 'Export assignment CSV',
            exportAssignmentJson: 'Export assignment JSON',
            exporting: 'Exporting…',
            exportSuccess: 'Grade file downloaded',
            exportFailed: 'Export failed. Try again.',
            window: 'Opens',
            duration: 'Time limit',
            attempts: 'Max submissions',
          },
    [i18n.language],
  );

  useSEO({
    title: t('teacher.seoTitle', '教學管理 — AI物聯網實驗室'),
    description: t(
      'teacher.seoDescription',
      '建立班級、發放班級代碼,即時掌握每位學生的課程進度與測驗成績。',
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
    if (!isTeacher) return;
    let cancelled = false;
    void lmsApi
      .teacherDashboard({
        q: classQuery.trim() || undefined,
      })
      .then((result) => {
        if (!cancelled) setDashboardStudents(result.students ?? []);
      })
      .catch(() => {
        if (!cancelled) setDashboardStudents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [classFilter, classQuery, classSort, isTeacher]);

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
    if (assignmentForm.assignment_type === 'quiz' && !assignmentForm.lesson_id && examQuestions.length === 0) {
      setAssignmentNotice(i18n.language.toLowerCase().startsWith('zh')
        ? '小測驗需要連結一課，系統才可以自動評分。'
        : 'A quiz must link to a lesson so it has questions to auto-grade.');
      return;
    }
    setAssignmentBusy(true);
    setAssignmentNotice('');
    try {
      const [courseId, lessonId] = assignmentForm.lesson_id.split('/');
      const linkedLesson = courseId && lessonId ? getLesson(courseId, lessonId) : null;
      const quiz = assignmentForm.assignment_type === 'quiz'
        ? examQuestions.length > 0
          ? examQuestions.map((question) => ({
              id: question.id,
              type: question.type,
              question: question.question.trim(),
              options: question.options,
              answer: question.answer,
              points: question.points,
              rubric: question.rubric.trim() || undefined,
            }))
          : linkedLesson?.lesson.quiz
        : undefined;
      const created = await lmsApi.createAssignment(selectedId, {
        title: assignmentForm.title.trim(),
        instructions: assignmentForm.instructions.trim(),
        lesson_id: assignmentForm.lesson_id || undefined,
        due_at: assignmentForm.due_at ? new Date(assignmentForm.due_at).toISOString() : undefined,
        max_score: Math.max(1, Number(assignmentForm.max_score) || 100),
        auto_grade: assignmentForm.auto_grade,
        assignment_type: assignmentForm.assignment_type,
        quiz,
        rubric: examQuestions.length > 0
          ? JSON.stringify(examQuestions.map((question) => ({ id: question.id, points: question.points, rubric: question.rubric })))
          : undefined,
        opens_at: assignmentForm.opens_at ? new Date(assignmentForm.opens_at).toISOString() : undefined,
        duration_minutes: assignmentForm.duration_minutes ? Math.max(1, Number(assignmentForm.duration_minutes)) : undefined,
        attempts_allowed: assignmentForm.attempts_allowed ? Math.max(1, Number(assignmentForm.attempts_allowed)) : undefined,
        allow_late: assignmentForm.allow_late,
        show_score_immediately: assignmentForm.show_score_immediately,
      });
      const assignment = publishImmediately ? await lmsApi.publishAssignment(created.id) : created;
      setAssignments((current) => [assignment, ...current]);
      setAssignmentForm({
        title: '',
        instructions: '',
        lesson_id: '',
        assignment_type: 'project',
        due_at: '',
        max_score: '100',
        auto_grade: true,
        opens_at: '',
        duration_minutes: '',
        attempts_allowed: '',
        allow_late: false,
        show_score_immediately: true,
      });
      setExamQuestions([]);
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
      setAssignments((current) =>
        current.map((item) => (item.id === published.id ? published : item)),
      );
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

  const gradeSubmission = async (
    submissionId: string,
    payload: { score: number | null; feedback: string; status: 'graded' | 'returned' },
  ) => {
    const api = lmsApi as typeof lmsApi & {
      gradeSubmission?: (id: string, value: typeof payload) => Promise<{ submission: LmsAssignmentSubmission }>;
    };
    if (!api.gradeSubmission) return;
    const result = await api.gradeSubmission(submissionId, payload);
    setSubmissions((current) => current.map((item) => item.id === submissionId ? result.submission : item));
    setAssignments((current) => current.map((item) => item.id === selectedAssignment?.id ? { ...item } : item));
  };

  const formatDate = (value: string | number | null | undefined) => {
    if (!value) return copy.noDeadline;
    // cloud_db stores timestamps as Unix seconds; tolerate ISO strings and
    // millisecond epochs from imported/older records as well.
    const dateValue = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime())
      ? copy.noDeadline
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          date,
        );
  };

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
    if (
      !window.confirm(
        t(
          'teacher.deleteConfirm',
          '確定要刪除這個班級嗎?學生的個人進度不會消失,但班級與名單會被移除。',
        ),
      )
    )
      return;
    await lmsApi.deleteClass(id).catch(() => {});
    if (selectedId === id) setSelectedId(null);
    await refresh();
  };

  const copyCode = (code: string) => {
    void navigator.clipboard?.writeText(code).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  };

  const visibleClasses = useMemo(() => {
    const query = classQuery.trim().toLowerCase();
    return classes
      .filter((item) => {
        if (classFilter === 'withStudents' && item.member_count === 0) return false;
        if (classFilter === 'empty' && item.member_count !== 0) return false;
        return !query || item.name.toLowerCase().includes(query) || item.code.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (classSort === 'name') return a.name.localeCompare(b.name, i18n.language);
        if (classSort === 'students') return b.member_count - a.member_count || a.name.localeCompare(b.name, i18n.language);
        return b.created_at - a.created_at;
      });
  }, [classes, classFilter, classQuery, classSort, i18n.language]);

  const exportGradeFile = async (
    format: 'csv' | 'json',
    classId?: string,
    assignmentId?: string,
  ) => {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      const blob = format === 'csv'
        ? await lmsApi.exportAssignmentsCsv(classId, assignmentId)
        : await lmsApi.exportAssignmentsJson(classId, assignmentId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const scope = assignmentId ? 'assignment' : classId ? 'class' : 'all';
      anchor.download = `velxio-grades-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setAssignmentNotice(copy.exportSuccess);
    } catch {
      setAssignmentNotice(copy.exportFailed);
    } finally {
      setExportBusy(false);
    }
  };

  const exportCsv = () => exportGradeFile('csv');
  const exportJson = () => exportGradeFile('json');

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
              '這個頁面需要教師帳號。你目前是學生身分 — 若你是老師,請用「教師」身分重新註冊一個帳號。',
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
          <button
            className="teacher-primary"
            onClick={createClass}
            disabled={busy || !newName.trim()}
          >
            {t('teacher.create', '建立班級')}
          </button>
        </div>

        <section className="teacher-overview" aria-labelledby="teacher-overview-title">
          <div>
            <p className="teacher-eyebrow">{copy.overview}</p>
            <h2 id="teacher-overview-title">{classes.length} {copy.classesCount}</h2>
          </div>
          <div className="teacher-overview-stat">
            <strong>{classes.reduce((sum, item) => sum + item.member_count, 0)}</strong>
            <span>{copy.studentsTotal}</span>
          </div>
          <div className="teacher-export-actions" role="group" aria-label={copy.exportCsv}>
            <button className="teacher-secondary" type="button" onClick={() => void exportCsv()} disabled={exportBusy}>
              {exportBusy ? copy.exporting : copy.exportCsv}
            </button>
            <button className="teacher-secondary" type="button" onClick={() => void exportJson()} disabled={exportBusy}>
              {exportBusy ? copy.exporting : copy.exportJson}
            </button>
          </div>
        </section>

        {classes.length > 0 && (
          <div className="teacher-class-tools" aria-label={copy.overview}>
            <label className="teacher-search">
              <span className="sr-only">{copy.classSearch}</span>
              <input value={classQuery} onChange={(event) => setClassQuery(event.target.value)} placeholder={copy.classSearch} />
            </label>
            <div className="teacher-filter-pills" role="group" aria-label={copy.allClasses}>
              {([['all', copy.allClasses], ['withStudents', copy.withStudents], ['empty', copy.emptyClasses]] as const).map(([value, label]) => (
                <button key={value} type="button" className={classFilter === value ? 'teacher-filter-active' : ''} onClick={() => setClassFilter(value)}>{label}</button>
              ))}
            </div>
            <label className="teacher-sort">
              <span>{i18n.language.toLowerCase().startsWith('zh') ? '排序' : 'Sort'}</span>
              <select value={classSort} onChange={(event) => setClassSort(event.target.value as typeof classSort)}>
                <option value="recent">{copy.sortRecent}</option>
                <option value="name">{copy.sortName}</option>
                <option value="students">{copy.sortStudents}</option>
              </select>
            </label>
          </div>
        )}

        {dashboardStudents.length > 0 && (
          <section className="teacher-student-overview" aria-labelledby="teacher-student-overview-title">
            <div className="teacher-section-heading">
              <div>
                <p className="teacher-eyebrow">{copy.overview}</p>
                <h2 id="teacher-student-overview-title">{i18n.language.toLowerCase().startsWith('zh') ? '學生完成情況' : 'Student progress'}</h2>
              </div>
              <span className="teacher-muted-count">{dashboardStudents.length} {copy.studentsTotal}</span>
            </div>
            <div className="teacher-table-scroll">
              <table className="teacher-student-table">
                <thead><tr>
                  <th>{i18n.language.toLowerCase().startsWith('zh') ? '學生' : 'Student'}</th>
                  <th>{i18n.language.toLowerCase().startsWith('zh') ? '班級' : 'Class'}</th>
                  <th>{i18n.language.toLowerCase().startsWith('zh') ? '課程進度' : 'Progress'}</th>
                  <th>{i18n.language.toLowerCase().startsWith('zh') ? '平均分' : 'Average'}</th>
                  <th>{i18n.language.toLowerCase().startsWith('zh') ? '狀態' : 'Status'}</th>
                </tr></thead>
                <tbody>{dashboardStudents.map((student) => {
                  const className = student.class_names?.join(', ') || '—';
                  const completion = student.completion_rate;
                  const status = student.late_count ? 'late' : completion === 100 ? 'complete' : 'in_progress';
                  return <tr key={`${student.class_ids?.join('-') ?? 'class'}-${student.id}`}>
                    <td><strong>{student.name}</strong><small>{student.email}</small></td>
                    <td>{className}</td>
                    <td><span className="teacher-progress-pill">{Number.isFinite(Number(completion)) ? `${Math.round(Number(completion))}%` : '—'}</span></td>
                    <td>{student.average_score === null ? '—' : Math.round(student.average_score)}</td>
                    <td><span className={`teacher-student-status teacher-student-status-${status}`}>{status === 'complete' ? (i18n.language.toLowerCase().startsWith('zh') ? '已完成' : 'Complete') : status === 'late' ? (i18n.language.toLowerCase().startsWith('zh') ? '有逾期' : 'Late') : (i18n.language.toLowerCase().startsWith('zh') ? '進行中' : 'In progress')}</span></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </section>
        )}

        {classes.length === 0 ? (
          <p className="teacher-empty">
            {t(
              'teacher.empty',
              '還沒有班級。建立第一個班級後,把班級代碼發給學生,他們在「課程」頁輸入代碼即可加入。',
            )}
          </p>
        ) : (
          <div className="teacher-class-list">
            {visibleClasses.length === 0 ? <p className="teacher-empty">{copy.emptyClasses}</p> : visibleClasses.map((c) => (
              <div
                key={c.id}
                className={
                  'teacher-class-card' + (selectedId === c.id ? ' teacher-class-selected' : '')
                }
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
              <button
                className="teacher-primary"
                onClick={() => setOpenComposer((value) => !value)}
              >
                {openComposer ? copy.close : copy.createAssignment}
              </button>
              <button
                className="teacher-secondary"
                type="button"
                onClick={() => void exportGradeFile('csv', selectedId)}
                disabled={exportBusy}
              >
                {exportBusy ? copy.exporting : copy.exportClassCsv}
              </button>
              <button
                className="teacher-secondary"
                type="button"
                onClick={() => void exportGradeFile('json', selectedId)}
                disabled={exportBusy}
              >
                {exportBusy ? copy.exporting : copy.exportClassJson}
              </button>
            </div>

            {assignmentNotice && (
              <p className="teacher-notice" role="status">
                {assignmentNotice}
              </p>
            )}

            {openComposer && (
              <form
                className="teacher-assignment-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createAssignment(false);
                }}
              >
                <label>
                  <span>{copy.assignmentTitle}</span>
                  <input
                    autoFocus
                    value={assignmentForm.title}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({ ...current, title: event.target.value }))
                    }
                    maxLength={100}
                    required
                  />
                </label>
                <label className="teacher-composer-wide">
                  <span>{copy.instructions}</span>
                  <textarea
                    value={assignmentForm.instructions}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({
                        ...current,
                        instructions: event.target.value,
                      }))
                    }
                    rows={4}
                    maxLength={3000}
                  />
                </label>
                <label>
                  <span>{copy.assignmentType}</span>
                  <select
                    value={assignmentForm.assignment_type}
                    onChange={(event) =>
                      setAssignmentForm((current) => {
                        const assignment_type = event.target
                          .value as typeof current.assignment_type;
                        return {
                          ...current,
                          assignment_type,
                          auto_grade: assignment_type === 'quiz',
                        };
                      })
                    }
                  >
                    <option value="project">{copy.project}</option>
                    <option value="quiz">{copy.quiz}</option>
                    <option value="reflection">{copy.reflection}</option>
                  </select>
                </label>
                <label>
                  <span>{copy.lesson}</span>
                  <select
                    value={assignmentForm.lesson_id}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({
                        ...current,
                        lesson_id: event.target.value,
                      }))
                    }
                  >
                    <option value="">{copy.allLessons}</option>
                    {COURSES.flatMap((course) =>
                      course.lessons.map((lesson) => (
                        <option
                          key={lessonKey(course.id, lesson.id)}
                          value={lessonKey(course.id, lesson.id)}
                        >
                          {course.title} · {lesson.title}
                        </option>
                      )),
                    )}
                  </select>
                </label>
                <label>
                  <span>{copy.deadline}</span>
                  <input
                    type="datetime-local"
                    value={assignmentForm.due_at}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({ ...current, due_at: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{copy.score}</span>
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    value={assignmentForm.max_score}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({
                        ...current,
                        max_score: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="teacher-check-label">
                  <input
                    type="checkbox"
                    checked={assignmentForm.auto_grade}
                    disabled={assignmentForm.assignment_type !== 'quiz'}
                    onChange={(event) =>
                      setAssignmentForm((current) => ({
                        ...current,
                        auto_grade: event.target.checked,
                      }))
                    }
                  />
                  <span>{copy.automatic}</span>
                </label>
                {assignmentForm.assignment_type === 'quiz' && (
                  <ExamBuilder
                    language={i18n.language}
                    questions={examQuestions}
                    onQuestionsChange={setExamQuestions}
                    settings={{
                      opens_at: assignmentForm.opens_at,
                      duration_minutes: assignmentForm.duration_minutes,
                      attempts_allowed: assignmentForm.attempts_allowed,
                      allow_late: assignmentForm.allow_late,
                      show_score_immediately: assignmentForm.show_score_immediately,
                    }}
                    onSettingsChange={(settings: ExamSettingsDraft) =>
                      setAssignmentForm((current) => ({ ...current, ...settings }))
                    }
                  />
                )}
                <div className="teacher-composer-actions">
                  <button
                    type="submit"
                    className="teacher-secondary"
                    disabled={assignmentBusy || !assignmentForm.title.trim() || (assignmentForm.assignment_type === 'quiz' && !assignmentForm.lesson_id && examQuestions.length === 0)}
                  >
                    {copy.saveDraft}
                  </button>
                  <button
                    type="button"
                    className="teacher-primary"
                    disabled={assignmentBusy || !assignmentForm.title.trim() || (assignmentForm.assignment_type === 'quiz' && !assignmentForm.lesson_id && examQuestions.length === 0)}
                    onClick={() => void createAssignment(true)}
                  >
                    {copy.publish}
                  </button>
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
                      <span className={'teacher-status teacher-status-' + assignment.status}>
                        {assignment.status === 'published' ? copy.published : copy.draft}
                      </span>
                      <span className="teacher-due">
                        {copy.due}: {formatDate(assignment.due_at)}
                      </span>
                    </div>
                    <h3>{assignment.title}</h3>
                    {assignment.instructions && <p>{assignment.instructions}</p>}
                    {(assignment.opens_at || assignment.duration_minutes || assignment.attempts_allowed) && (
                      <p className="teacher-assignment-timing">
                        {assignment.opens_at && `${copy.window}: ${formatDate(assignment.opens_at)}`}
                        {assignment.duration_minutes && ` · ${copy.duration}: ${assignment.duration_minutes} min`}
                        {assignment.attempts_allowed && ` · ${copy.attempts}: ${assignment.attempts_allowed}`}
                      </p>
                    )}
                    <dl className="teacher-assignment-metrics">
                      <div>
                        <dt>{copy.submissions}</dt>
                        <dd>{assignment.submission_count}</dd>
                      </div>
                      <div>
                        <dt>{copy.average}</dt>
                        <dd>
                          {assignment.average_score === null
                            ? '—'
                            : `${assignment.average_score}/${assignment.max_score}`}
                        </dd>
                      </div>
                      <div>
                        <dt>{copy.grading}</dt>
                        <dd>
                          {assignment.graded_count}/{assignment.submission_count}
                        </dd>
                      </div>
                    </dl>
                    <div className="teacher-assignment-actions">
                      {assignment.status !== 'published' && (
                        <button
                          className="teacher-secondary"
                          disabled={assignmentBusy}
                          onClick={() => void publishAssignment(assignment)}
                        >
                          {copy.publish}
                        </button>
                      )}
                      <button
                        className="teacher-text-button"
                        onClick={() => void reviewAssignment(assignment)}
                      >
                        {copy.review}
                      </button>
                      <button
                        className="teacher-text-button"
                        type="button"
                        onClick={() => void exportGradeFile('csv', selectedId, assignment.id)}
                        disabled={exportBusy}
                      >
                        {copy.exportAssignmentCsv}
                      </button>
                      <button
                        className="teacher-text-button"
                        type="button"
                        onClick={() => void exportGradeFile('json', selectedId, assignment.id)}
                        disabled={exportBusy}
                      >
                        {copy.exportAssignmentJson}
                      </button>
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
            <h2>{t('teacher.reportTitle', '「{{name}}」學習報表', { name: report.name })}</h2>
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
                            doneSet.has(lessonKey(course.id, l.id)),
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
          <div
            className="teacher-dialog-backdrop"
            role="presentation"
            onMouseDown={() => setSelectedAssignment(null)}
          >
            <section className="teacher-submission-dialog" role="dialog" aria-modal="true" aria-labelledby="submission-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
              <SubmissionGrader assignment={selectedAssignment} submissions={submissions} loading={submissionsLoading} language={i18n.language} onClose={() => setSelectedAssignment(null)} onGrade={gradeSubmission} loadAttempts={async (submissionId) => (await lmsApi.listSubmissionAttempts(submissionId)).attempts} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
