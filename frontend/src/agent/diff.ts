/**
 * Minimal line diff for the chat panel's code-change cards: common
 * prefix/suffix trim, then the changed middle as -/+ lines. Not a real LCS —
 * for teaching-sized sketches the changed region is what matters, and the
 * output stays readable.
 */

const CAP_LINES = 80;

export function lineDiff(oldText: string, newText: string): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);

  const out: string[] = [`@@ line ${start + 1}`];
  for (const l of removed.slice(0, CAP_LINES)) out.push(`- ${l}`);
  if (removed.length > CAP_LINES) out.push(`- … (+${removed.length - CAP_LINES} lines)`);
  for (const l of added.slice(0, CAP_LINES)) out.push(`+ ${l}`);
  if (added.length > CAP_LINES) out.push(`+ … (+${added.length - CAP_LINES} lines)`);
  return out.join('\n');
}
