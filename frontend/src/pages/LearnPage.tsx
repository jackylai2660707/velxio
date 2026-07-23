/**
 * 課程總覽 — course cards with per-lesson progress, plus the student's
 * class-membership widget (join by code). Anonymous visitors can take
 * every course; progress lives in localStorage until they sign in.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import { COURSES, courseLessonKeys } from '../learn/courses';
import { lessonKey } from '../learn/types';
import { useLearnStore } from '../learn/useLearnStore';
import { useCloudStore } from '../cloud/useCloudStore';
import { lmsApi, type LmsClassJoined, CloudApiError } from '../cloud/cloudApi';
import './LearnPage.css';

const JoinClassWidget: React.FC = () => {
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
      setMessage(
        t('learn.class.joinedMsg', '已加入「{{name}}」!', { name: cls.name })
      );
      const r = await lmsApi.listClasses();
      setClasses(r.joined);
    } catch (err) {
      setMessage(
        err instanceof CloudApiError && err.status === 404
          ? t('learn.class.unknownCode', '找不到這個班級代碼,請跟老師確認。')
          : t('learn.class.joinFailed', '加入失敗,請稍後再試。')
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

export const LearnPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();
  const user = useCloudStore((s) => s.user);
  const setAuthModalOpen = useCloudStore((s) => s.setAuthModalOpen);
  const done = useLearnStore((s) => s.done);
  const quizBest = useLearnStore((s) => s.quizBest);

  useSEO({
    title: t('learn.seoTitle', '課程 — AI物聯網實驗室'),
    description: t(
      'learn.seoDescription',
      'Arduino 入門與 ESP32 物聯網互動課程:原理解說、一鍵載入電路範例、動手挑戰與選擇題測驗。'
    ),
  });

  return (
    <div className="learn-page">
      <AppHeader />
      <div className="learn-container">
        <h1>{t('learn.title', '課程')}</h1>
        <p className="learn-subtitle">
          {t(
            'learn.subtitle',
            '每一課都能直接在瀏覽器裡動手做:讀原理、開範例電路、完成挑戰,再用小測驗確認自己學會了。'
          )}
        </p>

        {!user && (
          <div className="learn-signin-hint">
            {t(
              'learn.signinHint',
              '進度會先存在這台電腦。登入後可跨裝置同步,老師也能在班級報表看到你的進度。'
            )}{' '}
            <button onClick={() => setAuthModalOpen(true)}>
              {t('learn.signinCta', '登入 / 註冊')}
            </button>
          </div>
        )}

        <JoinClassWidget />

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
