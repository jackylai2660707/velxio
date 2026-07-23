/**
 * Integrity checks for the learning-module course content: stable ids,
 * example references that actually exist, well-formed quizzes, and no
 * Simplified-Chinese vocabulary leaking into the Traditional-Chinese copy.
 */

import { describe, it, expect } from 'vitest';
import { COURSES } from '../learn/courses';
import { lessonKey } from '../learn/types';
import { getExampleById } from '../data/examples';

// Mainland-Chinese tech terms that must not appear in zh-TW course copy.
const SIMPLIFIED_TERMS = /串口|引脚|舵机|代码|电阻|传感器|烧录|单片机|数码管/;

describe('learn course content', () => {
  it('has at least two courses with lessons', () => {
    expect(COURSES.length).toBeGreaterThanOrEqual(2);
    for (const course of COURSES) {
      expect(course.lessons.length, `course ${course.id} has lessons`).toBeGreaterThan(0);
    }
  });

  it('lesson ids are unique and stable-looking', () => {
    const seen = new Set<string>();
    for (const course of COURSES) {
      for (const lesson of course.lessons) {
        const key = lessonKey(course.id, lesson.id);
        expect(seen.has(key), `duplicate lesson key ${key}`).toBe(false);
        seen.add(key);
        expect(lesson.id).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('every exampleId resolves to a real example project', () => {
    for (const course of COURSES) {
      for (const lesson of course.lessons) {
        if (!lesson.exampleId) continue;
        expect(
          getExampleById(lesson.exampleId),
          `example '${lesson.exampleId}' (lesson ${course.id}/${lesson.id}) must exist`
        ).toBeDefined();
      }
    }
  });

  it('quizzes are well-formed', () => {
    for (const course of COURSES) {
      for (const lesson of course.lessons) {
        expect(
          lesson.quiz.length,
          `lesson ${course.id}/${lesson.id} needs at least 3 quiz questions`
        ).toBeGreaterThanOrEqual(3);
        const qids = new Set<string>();
        for (const q of lesson.quiz) {
          expect(qids.has(q.id), `duplicate quiz id ${q.id}`).toBe(false);
          qids.add(q.id);
          expect(q.options.length).toBeGreaterThanOrEqual(2);
          expect(q.options.length).toBeLessThanOrEqual(5);
          expect(q.answer).toBeGreaterThanOrEqual(0);
          expect(q.answer).toBeLessThan(q.options.length);
          expect(q.explanation.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('copy uses Taiwan terminology (no Simplified-Chinese tech terms)', () => {
    for (const course of COURSES) {
      const blob = JSON.stringify(course);
      const hit = blob.match(SIMPLIFIED_TERMS);
      expect(hit, `course ${course.id} contains '${hit?.[0]}'`).toBeNull();
    }
  });

  it('lessons have sections and reasonable time estimates', () => {
    for (const course of COURSES) {
      for (const lesson of course.lessons) {
        expect(lesson.sections.length).toBeGreaterThanOrEqual(2);
        expect(lesson.minutes).toBeGreaterThan(0);
        expect(lesson.minutes).toBeLessThanOrEqual(60);
      }
    }
  });
});
