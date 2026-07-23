/**
 * 教學管理 — teacher dashboard: create classes, hand out join codes, and
 * read the per-class report (lesson progress ✓ + best quiz score per
 * student, laid out per course). Requires a signed-in teacher account.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { useCloudStore } from '../cloud/useCloudStore';
import {
  lmsApi,
  type LmsClassTeaching,
  type LmsClassReport,
} from '../cloud/cloudApi';
import { COURSES } from '../learn/courses';
import { lessonKey } from '../learn/types';
import './TeacherPage.css';

export const TeacherPage: React.FC = () => {
  const { t } = useTranslation();
  const user = useCloudStore((s) => s.user);
  const sessionStatus = useCloudStore((s) => s.sessionStatus);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);

  const [classes, setClasses] = useState<LmsClassTeaching[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<LmsClassReport | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useSEO({
    title: t('teacher.seoTitle', '教學管理 — AI物聯網實驗室'),
    description: t(
      'teacher.seoDescription',
      '建立班級、發放班級代碼,即時掌握每位學生的課程進度與測驗成績。'
    ),
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
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

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
        <h1>{t('teacher.title', '教學管理')}</h1>

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
                onClick={() => setSelectedId(c.id)}
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

        {report && (
          <div className="teacher-report">
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
          </div>
        )}
      </div>
    </div>
  );
};
