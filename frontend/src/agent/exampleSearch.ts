/**
 * On-demand example retrieval for the AI assistant.
 *
 * The gallery ships ~500 worked projects with exact components, pin-level
 * wiring, required libraries, and code. The first-turn <reference_example>
 * injection (exampleHints.ts) covers the common single-device case with zero
 * latency; these tools cover everything it can't:
 *  - multi-device assignments (the injection picks only ONE example)
 *  - mid-conversation additions ("now add an OLED") where no injection runs
 *
 * Shared keyword scoring lives here; exampleHints re-uses it.
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
  [/温度|湿度/, ['dht', 'ds18b20', 'temperature', 'humidity']],
  [/温湿度/, ['dht22', 'dht11']],
  [/防水温度|水温|一线|1-wire/i, ['ds18b20', 'onewire']],
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

export function queryTerms(query: string): string[] {
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

export function scoreExample(ex: ExampleProject, terms: string[]): number {
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

export function exampleCode(ex: ExampleProject): string {
  return ex.code || ex.files?.[0]?.content || ex.boards?.[0]?.code || '';
}

// ── Tool-facing formatters ─────────────────────────────────────────────────

/** Top-5 matches, one line each — for the search_examples tool. */
export function searchExamplesText(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return 'Query too vague — search with a component or topic keyword, e.g. "oled", "servo", "红绿灯".';
  }
  const scored = exampleProjects
    .map((ex) => ({ ex, score: scoreExample(ex, terms) }))
    .filter((s) => s.score >= 2)
    .sort((a, z) => z.score - a.score)
    .slice(0, 5);
  if (scored.length === 0) return `No examples match "${query}".`;
  return scored
    .map(({ ex }) => {
      const board = ex.boards?.map((b) => b.boardKind).join('+') ?? ex.boardType ?? 'arduino-uno';
      const comps = ex.components
        .slice(0, 6)
        .map((c) => c.type)
        .join(', ');
      return `- ${ex.id} — ${ex.title} [${board}, ${ex.difficulty}] components: ${comps}`;
    })
    .join('\n')
    .concat('\n(Call get_example with an id for full wiring + code.)');
}

const CODE_BUDGET = 5000;

/** Full reference — components with properties, complete wiring, libraries,
 *  and code — for the get_example tool. */
export function getExampleText(id: string): string {
  const ex = exampleProjects.find((e) => e.id === id);
  if (!ex) {
    return `No example with id "${id}". Use search_examples to find valid ids.`;
  }
  const lines: string[] = [];
  lines.push(`# ${ex.title}`);
  lines.push(ex.description);
  if (ex.boards?.length) {
    lines.push(`boards: ${ex.boards.map((b) => b.boardKind).join(', ')}`);
  } else {
    lines.push(`board: ${ex.boardType ?? 'arduino-uno'}`);
  }
  if (ex.libraries?.length) lines.push(`libraries (install these exact names): ${ex.libraries.join(', ')}`);
  if (ex.languageMode === 'micropython') lines.push('language: micropython');
  if (ex.components.length > 0) {
    lines.push('components:');
    for (const c of ex.components) {
      const props =
        c.properties && Object.keys(c.properties).length > 0 ? ` ${JSON.stringify(c.properties)}` : '';
      lines.push(`- ${c.id}: ${c.type}${props}`);
    }
  }
  if (ex.wires.length > 0) {
    lines.push('wires (copy this pin-level wiring):');
    for (const w of ex.wires) {
      lines.push(`- ${w.start.componentId}:${w.start.pinName} -> ${w.end.componentId}:${w.end.pinName}`);
    }
  }
  const code = exampleCode(ex);
  if (code) {
    lines.push('code:');
    lines.push(code.length > CODE_BUDGET ? code.slice(0, CODE_BUDGET) + '\n…(truncated)' : code);
  }
  return lines.join('\n');
}
