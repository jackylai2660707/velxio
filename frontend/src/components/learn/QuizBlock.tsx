/**
 * Multiple-choice quiz for one lesson. Students pick an answer per
 * question and submit once; feedback shows per-question correctness and
 * the explanation, and the attempt is recorded via useLearnStore (which
 * also syncs to /api/lms when signed in).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuizQuestion } from '../../learn/types';
import { useLearnStore } from '../../learn/useLearnStore';
import './QuizBlock.css';

interface Props {
  lessonKey: string;
  questions: QuizQuestion[];
}

export const QuizBlock: React.FC<Props> = ({ lessonKey, questions }) => {
  const { t } = useTranslation();
  const submitQuiz = useLearnStore((s) => s.submitQuiz);
  const best = useLearnStore((s) => s.quizBest[lessonKey]);

  const [picked, setPicked] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);

  if (questions.length === 0) return null;

  const allAnswered = questions.every((q) => picked[q.id] !== undefined);
  const score = questions.reduce(
    (n, q) => n + (picked[q.id] === q.answer ? 1 : 0),
    0
  );

  const submit = () => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);
    submitQuiz(
      lessonKey,
      score,
      questions.length,
      questions.map((q) => picked[q.id] ?? -1)
    );
  };

  const retry = () => {
    setPicked({});
    setSubmitted(false);
  };

  return (
    <section className="quiz-block">
      <div className="quiz-header">
        <h2>{t('learn.quiz.title', '📝 小測驗')}</h2>
        {best && (
          <span className="quiz-best">
            {t('learn.quiz.best', '最佳成績')}: {best.best_score}/{best.total}
          </span>
        )}
      </div>

      {questions.map((q, qi) => {
        const chosen = picked[q.id];
        return (
          <div key={q.id} className="quiz-question">
            <p className="quiz-question-text">
              {qi + 1}. {q.question}
            </p>
            <div className="quiz-options">
              {q.options.map((opt, oi) => {
                let cls = 'quiz-option';
                if (!submitted && chosen === oi) cls += ' quiz-option-picked';
                if (submitted) {
                  if (oi === q.answer) cls += ' quiz-option-correct';
                  else if (chosen === oi) cls += ' quiz-option-wrong';
                }
                return (
                  <button
                    key={oi}
                    className={cls}
                    disabled={submitted}
                    onClick={() => setPicked((p) => ({ ...p, [q.id]: oi }))}
                  >
                    <span className="quiz-option-letter">
                      {String.fromCharCode(65 + oi)}
                    </span>
                    {opt}
                  </button>
                );
              })}
            </div>
            {submitted && (
              <p
                className={
                  'quiz-explanation ' +
                  (chosen === q.answer ? 'quiz-explanation-ok' : 'quiz-explanation-bad')
                }
              >
                {chosen === q.answer
                  ? t('learn.quiz.correct', '答對了!')
                  : t('learn.quiz.wrong', '答錯了。')}{' '}
                {q.explanation}
              </p>
            )}
          </div>
        );
      })}

      <div className="quiz-footer">
        {!submitted ? (
          <button
            className="quiz-submit"
            disabled={!allAnswered}
            onClick={submit}
          >
            {allAnswered
              ? t('learn.quiz.submit', '繳交答案')
              : t('learn.quiz.answerAll', '請先回答所有題目')}
          </button>
        ) : (
          <>
            <span className="quiz-score">
              {t('learn.quiz.score', '得分')}: {score}/{questions.length}
              {score === questions.length
                ? ' 🎉'
                : ''}
            </span>
            <button className="quiz-retry" onClick={retry}>
              {t('learn.quiz.retry', '再試一次')}
            </button>
          </>
        )}
      </div>
    </section>
  );
};
