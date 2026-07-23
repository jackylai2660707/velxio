/**
 * Single-lesson view: sidebar with the course outline, main column with
 * the Markdown sections, the "open circuit example" call-to-action
 * (routes to /example/:id — the existing ExampleEditorPage loads it into
 * the editor), the hands-on challenge, the quiz, and completion controls.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useSEO } from '../utils/useSEO';
import { getLesson } from '../learn/courses';
import { lessonKey } from '../learn/types';
import { useLearnStore } from '../learn/useLearnStore';
import { QuizBlock } from '../components/learn/QuizBlock';
import './LessonPage.css';

export const LessonPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();
  const { courseId = '', lessonId = '' } = useParams();
  const found = getLesson(courseId, lessonId);

  const done = useLearnStore((s) => s.done);
  const markDone = useLearnStore((s) => s.markDone);
  const resetLesson = useLearnStore((s) => s.resetLesson);

  useSEO({
    title: found
      ? `${found.lesson.title} — ${found.course.title} — ${t('brand.name', 'AI物聯網實驗室')}`
      : t('learn.seoTitle', '課程 — AI物聯網實驗室'),
    description: found?.course.description ?? '',
  });

  if (!found) return <Navigate to={localize('/learn')} replace />;
  const { course, lesson, index } = found;
  const key = lessonKey(course.id, lesson.id);
  const isDone = !!done[key];
  const prev = index > 0 ? course.lessons[index - 1] : null;
  const next = index < course.lessons.length - 1 ? course.lessons[index + 1] : null;

  return (
    <div className="lesson-page">
      <AppHeader />
      <div className="lesson-layout">
        {/* ── Course outline ─────────────────────────────── */}
        <aside className="lesson-sidebar">
          <Link to={localize('/learn')} className="lesson-back">
            ← {t('learn.backToCourses', '所有課程')}
          </Link>
          <div className="lesson-sidebar-course">
            <span aria-hidden>{course.emoji}</span> {course.title}
          </div>
          <ol className="lesson-sidebar-list">
            {course.lessons.map((l, i) => {
              const k = lessonKey(course.id, l.id);
              const active = l.id === lesson.id;
              return (
                <li key={l.id}>
                  <Link
                    to={localize(`/learn/${course.id}/${l.id}`)}
                    className={
                      'lesson-sidebar-item' +
                      (active ? ' lesson-sidebar-active' : '') +
                      (done[k] ? ' lesson-sidebar-done' : '')
                    }
                  >
                    <span className="lesson-sidebar-num">{done[k] ? '✓' : i + 1}</span>
                    {l.title}
                  </Link>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* ── Lesson body ────────────────────────────────── */}
        <main className="lesson-main">
          <div className="lesson-head">
            <h1>{lesson.title}</h1>
            <span className="lesson-minutes">
              ⏱ {t('learn.minutes', '{{m}} 分鐘', { m: lesson.minutes })}
            </span>
          </div>

          {lesson.exampleId && (
            <Link
              to={localize(`/example/${lesson.exampleId}`)}
              className="lesson-open-example"
            >
              ⚡ {t('learn.openExample', '開啟本課電路範例')}
            </Link>
          )}

          {lesson.sections.map((section, i) => (
            <section key={i} className="lesson-section">
              {section.heading && <h2>{section.heading}</h2>}
              <div className="lesson-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {section.markdown}
                </ReactMarkdown>
              </div>
            </section>
          ))}

          {lesson.challenge && (
            <section className="lesson-challenge">
              <h2>🚀 {t('learn.challenge', '動手挑戰')}</h2>
              <div className="lesson-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {lesson.challenge}
                </ReactMarkdown>
              </div>
            </section>
          )}

          <QuizBlock lessonKey={key} questions={lesson.quiz} />

          <div className="lesson-footer">
            <button
              className={'lesson-done-btn' + (isDone ? ' lesson-done-btn-active' : '')}
              onClick={() => (isDone ? resetLesson(key) : markDone(key))}
            >
              {isDone
                ? '✓ ' + t('learn.done', '已完成')
                : t('learn.markDone', '完成本課')}
            </button>
            <div className="lesson-nav">
              {prev && (
                <Link to={localize(`/learn/${course.id}/${prev.id}`)} className="lesson-nav-link">
                  ← {prev.title}
                </Link>
              )}
              {next && (
                <Link to={localize(`/learn/${course.id}/${next.id}`)} className="lesson-nav-link">
                  {next.title} →
                </Link>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
