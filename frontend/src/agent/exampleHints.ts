/**
 * Example-grounded prompting: match the user's request against the built-in
 * example gallery and inject the best-matching circuit (components + wiring +
 * a code excerpt) into the turn as a reference. Correct pin-level wiring is
 * the model's weakest spot; a worked example of the same sensor/display
 * eliminates most guessed pin names.
 *
 * Matching is keyword-based and bilingual: Chinese requests are mapped to
 * English component vocabulary first (queries have no word boundaries to
 * tokenize on).
 */

import { exampleProjects, type ExampleProject } from '../data/examples';

/** zh phrase → english keywords also searched against the example metadata */
const ZH_KEYWORDS: Array<[RegExp, string[]]> = [
  [/红绿灯|交通灯/, ['traffic', 'light']],
  [/超声波|测距|距离/, ['ultrasonic', 'hc-sr04', 'distance']],
  [/按钮|按键/, ['button', 'pushbutton']],
  [/电位器|旋钮/, ['potentiometer']],
  [/呼吸灯|渐变|pwm|调光/i, ['fade', 'pwm', 'dimmer', 'breathing']],
  [/舵机/, ['servo']],
  [/蜂鸣器|音乐|旋律/, ['buzzer', 'melody', 'tone']],
  [/温度|湿度/, ['dht', 'temperature', 'humidity']],
  [/温湿度/, ['dht22', 'dht11']],
  [/oled|屏幕|显示屏/i, ['oled', 'ssd1306', 'display']],
  [/lcd|液晶/i, ['lcd', 'lcd1602']],
  [/数码管/, ['seven', 'segment', '7-segment']],
  [/led|灯/i, ['led', 'blink']],
  [/闪烁|闪灯/, ['blink']],
  [/继电器/, ['relay']],
  [/光敏|光线|亮度传感/, ['ldr', 'photoresistor', 'light sensor']],
  [/摇杆/, ['joystick']],
  [/点阵/, ['matrix', 'max7219']],
  [/rgb/i, ['rgb']],
  [/串口/, ['serial']],
  [/红外/, ['ir', 'infrared']],
  [/步进电机/, ['stepper']],
  [/电机|马达/, ['motor']],
  [/键盘|矩阵键盘/, ['keypad']],
  [/时钟|rtc/i, ['rtc', 'clock', 'ds1307']],
];

const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'using', 'use', 'make', 'build', 'a', 'an', 'to', 'of', 'on',
]);

function queryTerms(query: string): string[] {
  const q = query.toLowerCase();
  const terms = new Set<string>();
  for (const [re, kws] of ZH_KEYWORDS) {
    if (re.test(q)) kws.forEach((k) => terms.add(k));
  }
  for (const w of q.split(/[^a-z0-9-]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) terms.add(w);
  }
  return [...terms];
}

function scoreExample(ex: ExampleProject, terms: string[]): number {
  const hay = `${ex.id} ${ex.title} ${ex.description} ${(ex.tags ?? []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (hay.includes(t)) score += t.length >= 5 ? 2 : 1;
  }
  // Prefer beginner-friendly single-board AVR examples as references
  if (ex.difficulty === 'beginner') score += 0.5;
  if (!ex.boards || ex.boards.length <= 1) score += 0.5;
  return score;
}

const CODE_EXCERPT_CHARS = 1400;
const MAX_TOTAL_CHARS = 2600;

/**
 * Returns a `<reference_example>` block for the best-matching example, or ''
 * when nothing matches well enough. Injected into the user turn by the store.
 */
export function buildExampleHint(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) return '';

  let best: ExampleProject | null = null;
  let bestScore = 0;
  for (const ex of exampleProjects) {
    const s = scoreExample(ex, terms);
    if (s > bestScore) {
      bestScore = s;
      best = ex;
    }
  }
  // Require at least one solid keyword hit beyond the structural bonuses
  if (!best || bestScore < 2) return '';

  const lines: string[] = [];
  lines.push(`(内置示例库中与请求最相关的参考电路 — 引脚接法可直接借鉴,但元件类型/坐标要按当前项目调整)`);
  lines.push(`title: ${best.title}`);
  if (best.boardType) lines.push(`board: ${best.boardType}`);
  if (best.components.length > 0) {
    lines.push('components:');
    for (const c of best.components.slice(0, 12)) {
      const props = c.properties && Object.keys(c.properties).length > 0
        ? ` ${JSON.stringify(c.properties)}`
        : '';
      lines.push(`- ${c.id}: ${c.type}${props}`);
    }
  }
  if (best.wires.length > 0) {
    lines.push('wires:');
    for (const w of best.wires.slice(0, 24)) {
      lines.push(`- ${w.start.componentId}:${w.start.pinName} -> ${w.end.componentId}:${w.end.pinName}`);
    }
  }
  const code = best.code || best.files?.[0]?.content || best.boards?.[0]?.code || '';
  if (code) {
    lines.push('code excerpt:');
    lines.push(code.slice(0, CODE_EXCERPT_CHARS));
  }

  let body = lines.join('\n');
  if (body.length > MAX_TOTAL_CHARS) body = body.slice(0, MAX_TOTAL_CHARS) + '\n…';
  return `<reference_example>\n${body}\n</reference_example>`;
}
