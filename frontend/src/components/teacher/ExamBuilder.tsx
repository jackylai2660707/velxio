import { useMemo, useState } from 'react';
import './ExamBuilder.css';
import { lmsApi } from '../../cloud/cloudApi';

export type ExamQuestionKind = 'single' | 'multiple' | 'true_false' | 'short' | 'long' | 'code' | 'circuit';

export interface ExamQuestionDraft {
  id: string;
  type: ExamQuestionKind;
  question: string;
  options: string[];
  answer: number | number[] | string;
  points: number;
  rubric: string;
}

export interface ExamSettingsDraft {
  opens_at: string;
  duration_minutes: string;
  attempts_allowed: string;
  allow_late: boolean;
  show_score_immediately: boolean;
}

interface ExamBuilderProps {
  language: string;
  questions: ExamQuestionDraft[];
  settings: ExamSettingsDraft;
  onQuestionsChange: (questions: ExamQuestionDraft[]) => void;
  onSettingsChange: (settings: ExamSettingsDraft) => void;
}

const INITIAL_OPTIONS = ['', '', '', ''];

const newQuestion = (type: ExamQuestionKind = 'single'): ExamQuestionDraft => ({
  id: `q-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
  type,
  question: '',
  options: type === 'true_false' ? ['True', 'False'] : type === 'single' || type === 'multiple' ? INITIAL_OPTIONS : [],
  answer: type === 'multiple' ? [] : type === 'true_false' || type === 'single' ? 0 : '',
  points: 10,
  rubric: '',
});

export const createExamQuestion = newQuestion;

export function ExamBuilder({
  language,
  questions,
  settings,
  onQuestionsChange,
  onSettingsChange,
}: ExamBuilderProps) {
  const zh = language.toLowerCase().startsWith('zh');
  const [aiTopic, setAiTopic] = useState('');
  const [aiCount, setAiCount] = useState('5');
  const [aiDifficulty, setAiDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('medium');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const copy = useMemo(
    () => zh
      ? {
          title: '自訂考題與評分規則',
          hint: '題目、答案與 rubric 僅儲存在教師端。學生只會看到作答所需內容。',
          add: '新增題目',
          question: '題目', type: '題型', points: '配分', answer: '正確答案', rubric: '評分規則 / AI 批改重點',
          delete: '刪除', duplicate: '複製', option: '選項', addOption: '新增選項', correct: '正確',
          timing: '考試時間與提交規則', opens: '開放作答時間', duration: '限時（分鐘）', attempts: '最多提交次數',
          late: '截止後允許遲交', showScore: '繳交後立即顯示自動評分結果',
          noLimit: '留空即不限時', unlimited: '留空即不限次數',
          types: {
            single: '單選題', multiple: '多選題', true_false: '判斷題', short: '簡答題', long: '長答題', code: '程式題', circuit: '電路題',
          },
          responseHint: '學生作答內容（簡答、程式或電路）將依 rubric 交由 AI 與測試規則評估。',
        }
      : {
          title: 'Custom questions & scoring',
          hint: 'Questions, answer keys, and rubrics remain teacher-only. Students receive only what they need to answer.',
          add: 'Add question',
          question: 'Question', type: 'Type', points: 'Points', answer: 'Correct answer', rubric: 'Rubric / AI grading focus',
          delete: 'Delete', duplicate: 'Duplicate', option: 'Option', addOption: 'Add option', correct: 'Correct',
          timing: 'Exam window & submission rules', opens: 'Opens at', duration: 'Time limit (minutes)', attempts: 'Maximum submissions',
          late: 'Allow late submission after the deadline', showScore: 'Show automatic result immediately after submission',
          noLimit: 'Blank means no time limit', unlimited: 'Blank means unlimited submissions',
          types: {
            single: 'Single choice', multiple: 'Multiple choice', true_false: 'True / false', short: 'Short answer', long: 'Long answer', code: 'Code task', circuit: 'Circuit task',
          },
          responseHint: 'Student responses (text, code, or circuit) are evaluated against the rubric by AI and test rules.',
        },
    [zh],
  );

  const patchQuestion = (id: string, patch: Partial<ExamQuestionDraft>) =>
    onQuestionsChange(questions.map((question) => question.id === id ? { ...question, ...patch } : question));

  const changeType = (question: ExamQuestionDraft, type: ExamQuestionKind) => {
    const fresh = newQuestion(type);
    patchQuestion(question.id, { ...fresh, id: question.id, question: question.question, points: question.points, rubric: question.rubric });
  };

  const answerText = (question: ExamQuestionDraft) => typeof question.answer === 'string' ? question.answer : '';
  const setMultipleAnswer = (question: ExamQuestionDraft, index: number, checked: boolean) => {
    const values = Array.isArray(question.answer) ? question.answer : [];
    patchQuestion(question.id, { answer: checked ? [...values, index] : values.filter((value) => value !== index) });
  };

  return (
    <section className="exam-builder" aria-labelledby="exam-builder-title">
      <header className="exam-builder-heading">
        <div>
          <p className="exam-builder-kicker">{zh ? 'EXAM STUDIO' : 'EXAM STUDIO'}</p>
          <h3 id="exam-builder-title">{copy.title}</h3>
          <p>{copy.hint}</p>
        </div>
        <button type="button" className="exam-builder-add" onClick={() => onQuestionsChange([...questions, newQuestion()])}>
          {copy.add}
        </button>
      </header>

      <div className="exam-ai-generator" aria-label={zh ? 'AI 產生題目' : 'AI question generator'}>
        <div>
          <strong>{zh ? 'AI 自動出題' : 'Generate with AI'}</strong>
          <p>{zh ? '輸入主題與要求，先產生草稿；確認後才會加入考卷。' : 'Describe the topic. AI creates an editable draft; nothing is added until you accept it.'}</p>
        </div>
        <div className="exam-ai-controls">
          <input value={aiTopic} onChange={(e) => setAiTopic(e.target.value)} placeholder={zh ? '例如：Arduino 按鈕控制 LED' : 'e.g. Arduino button-controlled LED'} maxLength={12000} />
          <input type="number" min="1" max="20" value={aiCount} onChange={(e) => setAiCount(e.target.value)} aria-label={zh ? '題數' : 'Question count'} />
          <select value={aiDifficulty} onChange={(e) => setAiDifficulty(e.target.value as typeof aiDifficulty)} aria-label={zh ? '難度' : 'Difficulty'}>
            <option value="easy">{zh ? '簡單' : 'Easy'}</option><option value="medium">{zh ? '中等' : 'Medium'}</option><option value="hard">{zh ? '困難' : 'Hard'}</option><option value="mixed">{zh ? '混合' : 'Mixed'}</option>
          </select>
          <button type="button" className="exam-builder-add" disabled={aiBusy || !aiTopic.trim()} onClick={async () => {
            setAiBusy(true); setAiError('');
            try {
              const result = await lmsApi.generateExamQuestions({ topic: aiTopic.trim(), count: Math.min(20, Math.max(1, Number(aiCount) || 5)), difficulty: aiDifficulty, language: zh ? 'zh-TW' : 'en', question_types: ['single', 'multiple', 'true_false', 'short', 'code', 'circuit'] });
              const generated = result.questions.map((q) => ({ id: q.id, type: q.type, question: q.question, options: q.options, answer: q.answer, points: q.points, rubric: q.rubric || q.explanation }));
              onQuestionsChange([...questions, ...generated]);
            } catch (error) {
              setAiError(error instanceof Error ? error.message : (zh ? 'AI 出題失敗' : 'AI generation failed'));
            } finally { setAiBusy(false); }
          }}>{aiBusy ? (zh ? '產生中…' : 'Generating…') : (zh ? 'AI 產生草稿' : 'Generate draft')}</button>
        </div>
        {aiError && <p className="exam-ai-error" role="alert">{aiError}</p>}
      </div>

      <div className="exam-builder-timing">
        <strong>{copy.timing}</strong>
        <div className="exam-builder-timing-grid">
          <label><span>{copy.opens}</span><input type="datetime-local" value={settings.opens_at} onChange={(event) => onSettingsChange({ ...settings, opens_at: event.target.value })} /></label>
          <label><span>{copy.duration}</span><input type="number" min="1" max="1440" inputMode="numeric" value={settings.duration_minutes} placeholder={copy.noLimit} onChange={(event) => onSettingsChange({ ...settings, duration_minutes: event.target.value })} /></label>
          <label><span>{copy.attempts}</span><input type="number" min="1" max="100" inputMode="numeric" value={settings.attempts_allowed} placeholder={copy.unlimited} onChange={(event) => onSettingsChange({ ...settings, attempts_allowed: event.target.value })} /></label>
        </div>
        <div className="exam-builder-toggles">
          <label><input type="checkbox" checked={settings.allow_late} onChange={(event) => onSettingsChange({ ...settings, allow_late: event.target.checked })} /><span>{copy.late}</span></label>
          <label><input type="checkbox" checked={settings.show_score_immediately} onChange={(event) => onSettingsChange({ ...settings, show_score_immediately: event.target.checked })} /><span>{copy.showScore}</span></label>
        </div>
      </div>

      {questions.length === 0 ? <p className="exam-builder-empty">{zh ? '尚未加入自訂考題。可使用連結課程的小測驗，或在此建立自己的題目。' : 'No custom questions yet. Use a linked lesson quiz, or build your own questions here.'}</p> : (
        <ol className="exam-builder-list">
          {questions.map((question, questionIndex) => {
            const hasOptions = question.type === 'single' || question.type === 'multiple' || question.type === 'true_false';
            return <li key={question.id} className="exam-question-card">
              <div className="exam-question-topline"><span>{zh ? `第 ${questionIndex + 1} 題` : `Question ${questionIndex + 1}`}</span><div><button type="button" onClick={() => onQuestionsChange([...questions.slice(0, questionIndex + 1), { ...question, id: newQuestion(question.type).id }, ...questions.slice(questionIndex + 1)])}>{copy.duplicate}</button><button type="button" className="exam-question-danger" onClick={() => onQuestionsChange(questions.filter((item) => item.id !== question.id))}>{copy.delete}</button></div></div>
              <div className="exam-question-meta">
                <label><span>{copy.type}</span><select value={question.type} onChange={(event) => changeType(question, event.target.value as ExamQuestionKind)}>{(Object.keys(copy.types) as ExamQuestionKind[]).map((kind) => <option key={kind} value={kind}>{copy.types[kind]}</option>)}</select></label>
                <label><span>{copy.points}</span><input type="number" min="1" max="1000" value={question.points} onChange={(event) => patchQuestion(question.id, { points: Math.max(1, Number(event.target.value) || 1) })} /></label>
              </div>
              <label className="exam-question-prompt"><span>{copy.question}</span><textarea rows={3} required value={question.question} onChange={(event) => patchQuestion(question.id, { question: event.target.value })} /></label>
              {hasOptions ? <div className="exam-options" role="group" aria-label={copy.answer}>
                <span className="exam-options-title">{copy.answer}</span>
                {question.options.map((option, index) => <label className="exam-option-row" key={`${question.id}-option-${index}`}>
                  <input type={question.type === 'multiple' ? 'checkbox' : 'radio'} name={question.type === 'multiple' ? undefined : question.id} checked={question.type === 'multiple' ? Array.isArray(question.answer) && question.answer.includes(index) : question.answer === index} onChange={(event) => question.type === 'multiple' ? setMultipleAnswer(question, index, event.target.checked) : patchQuestion(question.id, { answer: index })} />
                  <span className="sr-only">{copy.correct}</span><input aria-label={`${copy.option} ${index + 1}`} value={option} onChange={(event) => patchQuestion(question.id, { options: question.options.map((value, optionIndex) => optionIndex === index ? event.target.value : value) })} />
                  {question.type !== 'true_false' && question.options.length > 2 && <button type="button" aria-label={`${copy.delete} ${copy.option}`} onClick={() => patchQuestion(question.id, { options: question.options.filter((_, optionIndex) => optionIndex !== index), answer: question.type === 'multiple' ? (Array.isArray(question.answer) ? question.answer.filter((answer) => answer !== index).map((answer) => answer > index ? answer - 1 : answer) : []) : 0 })}>×</button>}
                </label>)}
                {question.type !== 'true_false' && question.options.length < 8 && <button className="exam-option-add" type="button" onClick={() => patchQuestion(question.id, { options: [...question.options, ''] })}>{copy.addOption}</button>}
              </div> : <label className="exam-answer-text"><span>{copy.answer}</span><textarea rows={question.type === 'code' ? 6 : 2} value={answerText(question)} onChange={(event) => patchQuestion(question.id, { answer: event.target.value })} placeholder={copy.responseHint} /></label>}
              <label className="exam-rubric"><span>{copy.rubric}</span><textarea rows={3} value={question.rubric} onChange={(event) => patchQuestion(question.id, { rubric: event.target.value })} placeholder={copy.responseHint} /></label>
            </li>;
          })}
        </ol>
      )}
    </section>
  );
}
