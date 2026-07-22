/**
 * Compile-error → recovery-hint mapping.
 *
 * A small table of the failure patterns students (and the model) hit most,
 * appended to the compile tool's failure output. It's a nudge toward the
 * right next tool call, not an expert system — keep it short.
 */

interface ErrorHint {
  pattern: RegExp;
  hint: (match: RegExpMatchArray) => string;
}

const HINTS: ErrorHint[] = [
  {
    pattern: /fatal error: ([\w./-]+)\.h: No such file/i,
    hint: (m) =>
      `Missing library header "${m[1]}.h" — find the exact registry name with ` +
      `search_libraries "${m[1]}", then install_library it.`,
  },
  {
    pattern: /'(\w+)' (?:was not declared|does not name a type)/,
    hint: (m) =>
      `"${m[1]}" is unknown to the compiler — usually a missing #include or a library ` +
      `that is not installed (search_libraries "${m[1]}"), or a typo.`,
  },
  {
    pattern: /redefinition of '(?:void )?(setup|loop)/,
    hint: () =>
      `Duplicate setup()/loop() — two files in this board's workspace both define them. ` +
      `Keep them only in sketch.ino; check with get_project and delete_file the stray copy ` +
      `(or write_file sketch.ino with the full merged code).`,
  },
  {
    pattern: /expected ';' before/,
    hint: () => `Missing semicolon just before the reported location.`,
  },
  {
    pattern: /expected '}' at end of input/,
    hint: () => `Unbalanced braces — a { was never closed. Re-read the file and count blocks.`,
  },
  {
    pattern: /'Serial[123]' was not declared/,
    hint: () =>
      `Extra hardware serial ports only exist on Mega/ESP32/Pico — on an Uno/Nano use ` +
      `SoftwareSerial or the single "Serial".`,
  },
];

/** Return hint lines (possibly empty) for a compile error blob. */
export function compileErrorHints(errorText: string): string[] {
  const hints: string[] = [];
  for (const { pattern, hint } of HINTS) {
    const m = errorText.match(pattern);
    if (m) hints.push(hint(m));
    if (hints.length >= 3) break;
  }
  return hints;
}
