/**
 * Course registry for the learning module. Content lives in per-course
 * files; ids are stable progress keys — never rename them once published.
 */

import type { Course, Lesson } from './types';
import { lessonKey } from './types';
import { arduinoBasicsCourse } from './course-arduino';
import { esp32IotCourse } from './course-esp32';

export const COURSES: Course[] = [arduinoBasicsCourse, esp32IotCourse];

export function getCourse(courseId: string): Course | undefined {
  return COURSES.find((c) => c.id === courseId);
}

export function getLesson(
  courseId: string,
  lessonId: string
): { course: Course; lesson: Lesson; index: number } | undefined {
  const course = getCourse(courseId);
  if (!course) return undefined;
  const index = course.lessons.findIndex((l) => l.id === lessonId);
  if (index === -1) return undefined;
  return { course, lesson: course.lessons[index], index };
}

/** All lesson keys of one course, in order. */
export function courseLessonKeys(course: Course): string[] {
  return course.lessons.map((l) => lessonKey(course.id, l.id));
}
