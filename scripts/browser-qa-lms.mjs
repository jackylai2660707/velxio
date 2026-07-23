#!/usr/bin/env node
/**
 * browser-qa-lms.mjs — in-browser smoke QA for the「AI物聯網實驗室」brand +
 * learning-management layer.
 *
 * Verifies what unit tests cannot: the branded landing page renders in
 * Traditional Chinese at `/`, the course list and lesson player work, the
 * quiz grades and persists, lesson completion survives a reload, and the
 * teacher flow (register → create class → student joins → report shows the
 * student's progress and quiz score) works end-to-end through the real
 * backend.
 *
 *   bash: frontend on :5173 (vite) + backend on :8001, then
 *   node scripts/browser-qa-lms.mjs
 *
 * Env: QA_APP_URL (default http://localhost:5173),
 *      QA_CHROME (default /usr/bin/google-chrome), QA_SHOTS=1 for PNGs.
 *
 * Accounts are created fresh each run (timestamped emails) in the backend's
 * SQLite — harmless test rows in a dev database.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'frontend', 'package.json'));
let puppeteer;
try {
  puppeteer = (await import(require.resolve('puppeteer-core'))).default;
} catch {
  console.error('puppeteer-core not found — run `npm install` in frontend/ first.');
  process.exit(2);
}

const APP = process.env.QA_APP_URL ?? 'http://localhost:5173';
const CHROME =
  process.env.QA_CHROME ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) {
  console.error('No Chrome/Chromium found — set QA_CHROME=/path/to/chrome.');
  process.exit(2);
}
const SHOTS = process.env.QA_SHOTS === '1';
const shotsDir = join(repoRoot, 'qa-shots');
if (SHOTS) mkdirSync(shotsDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900'],
  protocolTimeout: 240000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const shot = async (name) => SHOTS && page.screenshot({ path: join(shotsDir, `lms-${name}.png`) });

const RUN = Date.now();
const TEACHER = { email: `qa-teacher-${RUN}@test.tw`, password: 'secret123', name: 'QA老師' };
const STUDENT = { email: `qa-student-${RUN}@test.tw`, password: 'secret123', name: 'QA學生' };

/** REST helper executed in page context (uses the vite /api proxy). */
const api = (path, opts = {}) =>
  page.evaluate(
    async (p, o) => {
      const r = await fetch(`/api${p}`, {
        method: o.method ?? 'GET',
        headers: {
          ...(o.body ? { 'Content-Type': 'application/json' } : {}),
          ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
        },
        body: o.body ? JSON.stringify(o.body) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    path,
    opts
  );

try {
  // ── 1. Brand landing ────────────────────────────────────────────────
  console.log('\n── 品牌落地頁 ──');
  await page.goto(APP + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.brand-hero-title', { timeout: 30000 });
  const landing = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    h1: document.querySelector('.brand-hero-title')?.textContent ?? '',
    header: document.querySelector('.header-title')?.textContent ?? '',
    ctas: [...document.querySelectorAll('.brand-hero-ctas a')].map((a) => a.getAttribute('href')),
  }));
  check('html lang 是 zh-TW', landing.lang === 'zh-TW', landing.lang);
  check('標題含品牌名', landing.title.includes('AI物聯網實驗室'), landing.title);
  check('hero 是繁中', landing.h1.includes('物聯網實驗室'), landing.h1);
  check('header wordmark 是品牌名', landing.header === 'AI物聯網實驗室', landing.header);
  check(
    'CTA 指向 /learn 與 /editor',
    landing.ctas.includes('/learn') && landing.ctas.includes('/editor'),
    JSON.stringify(landing.ctas)
  );
  await shot('landing');

  // ── 2. Course list ──────────────────────────────────────────────────
  console.log('\n── 課程總覽 ──');
  await page.goto(APP + '/learn', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.learn-course-card', { timeout: 30000 });
  const courses = await page.evaluate(() =>
    [...document.querySelectorAll('.learn-course-card')].map((c) => ({
      title: c.querySelector('h2')?.textContent,
      lessons: c.querySelectorAll('.learn-lesson-row').length,
    }))
  );
  check('顯示 2 門課程', courses.length === 2, JSON.stringify(courses));
  check(
    '每門課有課次',
    courses.every((c) => c.lessons >= 5),
    JSON.stringify(courses)
  );
  await shot('learn');

  // ── 3. Lesson player + quiz ─────────────────────────────────────────
  console.log('\n── 單課頁與測驗 ──');
  await page.click('.learn-lesson-row');
  await page.waitForSelector('.lesson-main h1', { timeout: 30000 });
  const lesson = await page.evaluate(() => ({
    title: document.querySelector('.lesson-main h1')?.textContent ?? '',
    hasMarkdown: !!document.querySelector('.lesson-markdown p'),
    hasExampleBtn: !!document.querySelector('.lesson-open-example'),
    exampleHref: document.querySelector('.lesson-open-example')?.getAttribute('href') ?? '',
    quizQuestions: document.querySelectorAll('.quiz-question').length,
    sidebarItems: document.querySelectorAll('.lesson-sidebar-item').length,
  }));
  check('課文 Markdown 已渲染', lesson.hasMarkdown);
  check('有「開啟電路範例」按鈕', lesson.hasExampleBtn, lesson.exampleHref);
  check('例路徑是 /example/:id', /^\/example\/.+/.test(lesson.exampleHref), lesson.exampleHref);
  check('測驗題數 ≥ 3', lesson.quizQuestions >= 3, String(lesson.quizQuestions));
  check('側欄有課次列表', lesson.sidebarItems >= 5, String(lesson.sidebarItems));

  // answer every question (first option), submit, expect a score
  const submitState = await page.evaluate(() => {
    document
      .querySelectorAll('.quiz-question')
      .forEach((q) => q.querySelector('.quiz-option')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    return document.querySelector('.quiz-submit')?.textContent ?? 'missing';
  });
  check('全部作答後可繳交', submitState.includes('繳交'), submitState);
  await page.click('.quiz-submit');
  await page.waitForSelector('.quiz-score', { timeout: 10000 });
  const quiz = await page.evaluate(() => ({
    score: document.querySelector('.quiz-score')?.textContent ?? '',
    explanations: document.querySelectorAll('.quiz-explanation').length,
  }));
  check('顯示得分', /\d+\/\d+/.test(quiz.score), quiz.score);
  check('每題顯示解說', quiz.explanations >= 3, String(quiz.explanations));
  await shot('quiz');

  // ── 4. Completion persists across reload ────────────────────────────
  console.log('\n── 進度持久化 ──');
  await page.click('.lesson-done-btn');
  await page.goto(APP + '/learn', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.learn-course-card', { timeout: 30000 });
  const progressText = await page.evaluate(
    () => document.querySelector('.learn-progress-text')?.textContent ?? ''
  );
  check('重新整理後進度保留 (1 課完成)', progressText.trim().startsWith('1/'), progressText);

  // ── 5. Teacher flow through the real backend ────────────────────────
  console.log('\n── 師生後端流程 ──');
  const tReg = await api('/auth/register', {
    method: 'POST',
    body: { ...TEACHER, role: 'teacher', teacher_code: '' },
  });
  check('教師註冊', tReg.status === 200 && tReg.json?.user?.role === 'teacher', JSON.stringify(tReg));
  const tTok = tReg.json.token;

  const sReg = await api('/auth/register', { method: 'POST', body: { ...STUDENT, role: 'student' } });
  check('學生註冊', sReg.status === 200, JSON.stringify(sReg.json));
  const sTok = sReg.json.token;

  const cls = await api('/lms/classes', { method: 'POST', token: tTok, body: { name: 'QA 測試班' } });
  check('教師建立班級', cls.status === 200 && /^[A-Z2-9]{6}$/.test(cls.json?.code ?? ''), JSON.stringify(cls.json));

  const join = await api('/lms/classes/join', { method: 'POST', token: sTok, body: { code: cls.json.code } });
  check('學生用代碼加入', join.status === 200, JSON.stringify(join.json));

  await api('/lms/progress', { method: 'POST', token: sTok, body: { lesson_id: 'arduino-basics/blink' } });
  await api('/lms/quiz', {
    method: 'POST',
    token: sTok,
    body: { lesson_id: 'arduino-basics/blink', score: 3, total: 3, answers: [0, 1, 2] },
  });

  // Teacher dashboard UI with the teacher signed in
  await page.evaluate((tok) => localStorage.setItem('velxio-cloud-token', tok), tTok);
  await page.goto(APP + '/teacher', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.teacher-class-card', { timeout: 30000 });
  await page.click('.teacher-class-card');
  await page.waitForSelector('.teacher-report table', { timeout: 30000 });
  const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.teacher-course-table')].map((tbl) => ({
      course: tbl.querySelector('h3')?.textContent ?? '',
      students: [...tbl.querySelectorAll('tbody tr')].map((tr) => ({
        name: tr.querySelector('.teacher-student-cell')?.textContent ?? '',
        progress: tr.children[1]?.textContent ?? '',
        doneCells: tr.querySelectorAll('.teacher-cell-done').length,
        quizCells: [...tr.querySelectorAll('.teacher-cell-quiz')].map((c) => c.textContent),
      })),
    }));
    return rows;
  });
  const arduinoRow = report.find((r) => r.course.includes('Arduino'))?.students?.[0];
  check('報表列出學生', arduinoRow?.name === 'QA學生', JSON.stringify(arduinoRow));
  check('報表顯示完成進度 1/…', (arduinoRow?.progress ?? '').startsWith('1/'), arduinoRow?.progress);
  check('報表含 ✓ 完成格', (arduinoRow?.doneCells ?? 0) >= 1, String(arduinoRow?.doneCells));
  check('報表含測驗成績 3/3', (arduinoRow?.quizCells ?? []).includes('3/3'), JSON.stringify(arduinoRow?.quizCells));
  await shot('teacher');
} catch (err) {
  check('未捕捉例外', false, err.message);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
