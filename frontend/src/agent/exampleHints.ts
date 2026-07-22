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
import { queryTerms, scoreExample, exampleCode } from './exampleSearch';

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
  const code = exampleCode(best);
  if (code) {
    lines.push('code excerpt:');
    lines.push(code.slice(0, CODE_EXCERPT_CHARS));
  }

  let body = lines.join('\n');
  if (body.length > MAX_TOTAL_CHARS) body = body.slice(0, MAX_TOTAL_CHARS) + '\n…';
  body += `\n(这只是单个最相关示例。作业涉及其他器件时,用 search_examples / get_example 获取对应器件的完整参考。)`;
  return `<reference_example>\n${body}\n</reference_example>`;
}
