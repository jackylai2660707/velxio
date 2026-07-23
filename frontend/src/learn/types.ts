/**
 * Course/lesson data model for the「AI物聯網實驗室」learning module.
 *
 * Content ships with the frontend (src/learn/course-*.ts) — the backend
 * only stores per-user state keyed by `lessonKey(courseId, lessonId)`,
 * so ids must stay stable once published (they are what progress and
 * quiz records point at).
 */

export interface QuizQuestion {
  /** Stable id within the lesson (e.g. 'q1'). */
  id: string;
  /** Question text (Markdown inline allowed). */
  question: string;
  /** 2-5 choices; index into this array is the submitted answer. */
  options: string[];
  /** Index of the correct option. */
  answer: number;
  /** Shown after answering — the one-sentence WHY. */
  explanation: string;
}

export interface LessonSection {
  /** Optional heading rendered above the body. */
  heading?: string;
  /** GitHub-flavored Markdown (code fences supported). */
  markdown: string;
}

export interface Lesson {
  /** Stable slug, unique within the course (e.g. 'blink'). */
  id: string;
  title: string;
  /** Estimated minutes to complete — shown as a badge. */
  minutes: number;
  /**
   * Example project to open in the editor ("開啟電路範例" button →
   * /example/:exampleId). Must exist in src/data/examples*.ts.
   */
  exampleId?: string;
  sections: LessonSection[];
  /** Hands-on challenge (Markdown) shown after the sections. */
  challenge?: string;
  quiz: QuizQuestion[];
}

export interface Course {
  /** Stable slug (e.g. 'arduino-basics'). */
  id: string;
  title: string;
  description: string;
  /** e.g. '入門' | '進階'. */
  level: string;
  /** Emoji used as the course icon on cards. */
  emoji: string;
  lessons: Lesson[];
}

/** Canonical key used for progress + quiz records (backend lesson_id). */
export function lessonKey(courseId: string, lessonId: string): string {
  return `${courseId}/${lessonId}`;
}
