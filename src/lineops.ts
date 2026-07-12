// Pure line-oriented text transforms for the Edit > Line Operations menu
// (ROADMAP.md Track C). Every function here is `(text: string) => string`
// with no editor/CodeMirror dependency, so it is unit-testable without a
// WebView (see lineops.test.ts) and reusable from both
// `EditorHandle.transformLines` (line-boundary-expanded selection, or the
// whole document) and `EditorHandle.transformSelection` (selection
// verbatim, or the whole document) in editor.ts.
//
// Contract shared by all five: input and output are LF text (the editor
// buffer is always LF-normalized before it reaches the frontend — see
// CLAUDE.md "Hard constraints"), and an empty string maps to an empty
// string.

/**
 * Split LF text into its lines (terminators stripped) plus whether the
 * text ended with a trailing newline, so a transform that only reorders
 * or filters the line array can restore that trailing-newline presence
 * exactly via `joinLines`. Without tracking this separately, `"a\nb\n"`
 * and `"a\nb"` would both naively split into `["a", "b"]`-shaped data and
 * there would be no way to tell which one should regain the trailing
 * newline on the way back out.
 */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop(); // drop the empty tail split() adds after a final "\n"
  return { lines, trailingNewline };
}

/** Inverse of `splitLines`: rejoin a line array, restoring a trailing
 *  newline only when the original text had one. */
function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Compare two strings by Unicode code point, not UTF-16 code unit. Plain
 * `a < b` (and `Array.prototype.sort()` with no comparator) compares
 * UTF-16 code units, which misorders supplementary-plane characters
 * (surrogate pairs, code point >= U+10000) against BMP characters above
 * U+E000: a surrogate pair's lead unit (U+D800-U+DBFF) numerically
 * precedes those BMP characters even though the code point it encodes is
 * numerically larger. Iterating each string with the string iterator
 * (which yields whole code points, pairing surrogates) and comparing
 * `codePointAt(0)` avoids that. Not `localeCompare`: it depends on the
 * runtime's ICU/locale data, which is exactly the platform-dependent
 * nondeterminism `sortLines` must not have.
 */
function compareCodePoints(a: string, b: string): number {
  const aChars = a[Symbol.iterator]();
  const bChars = b[Symbol.iterator]();
  for (;;) {
    const nextA = aChars.next();
    const nextB = bChars.next();
    if (nextA.done && nextB.done) return 0;
    if (nextA.done) return -1; // a ran out first: a is a prefix of b, sorts first
    if (nextB.done) return 1;
    // Each token is one whole code point (possibly a surrogate pair), so
    // codePointAt(0) is always defined here.
    const codeA = nextA.value.codePointAt(0)!;
    const codeB = nextB.value.codePointAt(0)!;
    if (codeA !== codeB) return codeA - codeB;
  }
}

/**
 * Sort lines by Unicode code point (see `compareCodePoints`) — locale-
 * independent and deterministic across platforms, unlike `localeCompare`.
 * `Array.prototype.sort` has been a stable sort per spec since ES2019, so
 * lines that compare equal (i.e. identical lines) keep their relative
 * order and none are dropped. Trailing-newline presence is preserved.
 */
export function sortLines(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  lines.sort(compareCodePoints);
  return joinLines(lines, trailingNewline);
}

/**
 * Remove duplicate lines, keeping the first occurrence of each and
 * dropping every later repeat regardless of adjacency (not just
 * consecutive runs). Trailing-newline presence is preserved.
 */
export function uniqueLines(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
  }
  return joinLines(kept, trailingNewline);
}

/**
 * Strip trailing spaces and tabs from every line. Deliberately does not
 * strip `\r`: the editor buffer is always LF-normalized (CLAUDE.md "Hard
 * constraints"), so a line here should never actually end in `\r`, but if
 * one somehow did, silently eating it would be exactly the kind of
 * "quietly changes bytes it wasn't asked to touch" behavior this codebase
 * avoids everywhere else for encoding/line-ending data.
 */
export function trimTrailingWhitespace(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  const trimmed = lines.map((line) => line.replace(/[ \t]+$/, ""));
  return joinLines(trimmed, trailingNewline);
}

/**
 * Upper-case the given text (the whole document, or just the selection —
 * the caller, `EditorHandle.transformSelection`, decides which). Plain
 * `String.prototype.toUpperCase`, accepted as-is including its Unicode
 * default case mapping's expansions (e.g. German 'ß' -> 'SS').
 */
export function upperCase(text: string): string {
  return text.toUpperCase();
}

/** Lower-case counterpart of `upperCase`; see its docs. */
export function lowerCase(text: string): string {
  return text.toLowerCase();
}
