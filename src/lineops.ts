// Pure line-oriented text transforms for the Edit > Line Operations menu
// (ROADMAP.md Track C), plus `lineSpanForSelection`, the pure selection-
// boundary math `EditorHandle.transformLines` needs before it can call
// them. Nothing here touches CodeMirror or the DOM, so all of it is
// unit-testable without a WebView (see lineops.test.ts) and reusable from
// both `EditorHandle.transformLines` (line-boundary-expanded selection, or
// the whole document) and `EditorHandle.transformSelection` (selection
// verbatim, or the whole document) in editor.ts.
//
// Contract shared by the five `(text: string) => string` transforms below
// (sortLines/uniqueLines/trimTrailingWhitespace/upperCase/lowerCase):
// input and output are LF text (the editor buffer is always LF-normalized
// before it reaches the frontend — see CLAUDE.md "Hard constraints"), and
// an empty string maps to an empty string. `lineSpanForSelection`, at the
// end of this file, has a different shape — it returns character offsets,
// not text — because it answers a different question; see its own doc
// comment.

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

/**
 * Convert fullwidth ASCII-range characters (U+FF01-FF5E, the Unicode
 * "Fullwidth Forms" block's fixed +0xFEE0 offset from ASCII U+0021-007E --
 * '！' through '～', which already includes the fullwidth dollar sign '＄'
 * at U+FF04, so no separate currency-symbol case is needed) to their plain
 * ASCII equivalents, and the ideographic space (U+3000, CJK's full-width
 * space) to a plain ASCII space (U+0020). This is the conventional
 * CJK-input-method "convert to half-width" operation (ROADMAP.md v0.4
 * Track A). Deliberately narrow: halfwidth katakana (U+FF61-FF9F -- a
 * *different* Unicode block, already called "half-width" for an unrelated
 * reason) and every other character (CJK ideographs, tabs, newlines, plain
 * ASCII space) pass through unchanged, which is what makes this the exact
 * inverse of `toFullWidth` on their shared domain (see that function's
 * docs and lineops.test.ts's bijection suite). Iterates with the string
 * iterator (whole code points, not UTF-16 code units), the same technique
 * `compareCodePoints` above uses, so an adjacent supplementary-plane
 * character (a surrogate pair) is never split.
 */
export function toHalfWidth(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) {
      result += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCodePoint(code - 0xfee0);
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Inverse of `toHalfWidth`: ASCII printable characters (U+0021-007E) to
 * their fullwidth counterparts (+0xFEE0, landing in U+FF01-FF5E), and the
 * plain ASCII space (U+0020) to the ideographic space (U+3000). Converting
 * an ordinary Western space to a fullwidth one can look surprising out of
 * context, but it is the standard, symmetric counterpart the CJK
 * typesetting workflow this command targets expects -- a document run
 * through "convert to full-width" is meant to read as uniformly
 * full-width, spaces included, and the pair round-trips exactly back
 * through `toHalfWidth` either way. Every other character (CJK ideographs,
 * halfwidth katakana, tabs, newlines) passes through unchanged, and code
 * points are iterated the same surrogate-pair-safe way as `toHalfWidth`.
 */
export function toFullWidth(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x0020) {
      result += "　";
    } else if (code >= 0x0021 && code <= 0x007e) {
      result += String.fromCodePoint(code + 0xfee0);
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Clamp a tab/indent width to a positive integer — guards
 * `convertLeadingTabsToSpaces`/`convertLeadingSpacesToTabs` below against a
 * zero or negative width, which would otherwise hit a modulo-by-zero
 * (`column % 0` is `NaN`) or a negative-count `" ".repeat`/`"\t".repeat`
 * (a `RangeError`). Both callers pass CM6's live `tabSize` (see editor.ts's
 * `EditorHandle.transformLines` callers in main.ts), which is always a
 * positive integer in practice — this is defensive, not a real-world path.
 */
function clampWidth(width: number): number {
  return Math.max(1, Math.trunc(width));
}

/**
 * Convert one line's *leading* run of spaces/tabs to spaces at `width`
 * columns, leaving the rest of the line (interior/trailing whitespace and
 * all other content) untouched. A tab expands to the next multiple of
 * `width` columns, not a flat `width`-spaces substitution — same
 * tab-stop convention as editor.ts's `indentGuideLevels` (a tab's width
 * depends on the column it starts at) — so this is correct even when the
 * leading run already mixes tabs and spaces, not just for a pure-tabs line.
 */
function expandLeadingIndentToSpaces(line: string, width: number): string {
  let end = 0;
  while (end < line.length && (line[end] === " " || line[end] === "\t")) end++;
  if (end === 0) return line;

  let column = 0;
  let spaces = "";
  for (let i = 0; i < end; i++) {
    if (line[i] === "\t") {
      const toNextStop = width - (column % width);
      spaces += " ".repeat(toNextStop);
      column += toNextStop;
    } else {
      spaces += " ";
      column += 1;
    }
  }
  return spaces + line.slice(end);
}

/**
 * Convert leading tabs (or a leading run mixing tabs and spaces) to spaces
 * throughout `text`, at `width` spaces per tab stop. Edit > Line
 * Operations' "Convert Leading Tabs to Spaces" (ROADMAP.md v0.4 Track C);
 * `width` is the buffer's current effective tab width (CM6's own
 * `EditorState.tabSize`, itself driven by indentdetect.ts's detection — see
 * editor.ts `EditorHandle.setIndentation`), not necessarily 4. See
 * `expandLeadingIndentToSpaces` for the per-line conversion and this
 * module's header comment for the shared trailing-newline contract.
 */
export function convertLeadingTabsToSpaces(text: string, width: number): string {
  if (text === "") return "";
  const w = clampWidth(width);
  const { lines, trailingNewline } = splitLines(text);
  const converted = lines.map((line) => expandLeadingIndentToSpaces(line, w));
  return joinLines(converted, trailingNewline);
}

/**
 * Inverse per-line conversion of `expandLeadingIndentToSpaces`: measure the
 * leading run's total column width (tabs already present expand to the next
 * stop, same convention as above, so a leading run that already mixes tabs
 * and spaces is handled correctly too), then re-emit one tab per full
 * `width`-column group with any leftover columns (less than `width`) kept
 * as literal spaces — "group by integer division of width, keep the
 * remainder as spaces".
 */
function collapseLeadingIndentToTabs(line: string, width: number): string {
  let end = 0;
  while (end < line.length && (line[end] === " " || line[end] === "\t")) end++;
  if (end === 0) return line;

  let column = 0;
  for (let i = 0; i < end; i++) {
    column += line[i] === "\t" ? width - (column % width) : 1;
  }
  const tabs = Math.floor(column / width);
  const remainder = column % width;
  return "\t".repeat(tabs) + " ".repeat(remainder) + line.slice(end);
}

/**
 * Convert leading spaces (or a leading run mixing spaces and tabs) to tabs
 * throughout `text`, grouping every `width` columns of leading indentation
 * into one tab and keeping any remaining (less-than-`width`) columns as
 * spaces. Edit > Line Operations' "Convert Leading Spaces to Tabs"
 * (ROADMAP.md v0.4 Track C); `width` is the buffer's current effective tab
 * width, same as `convertLeadingTabsToSpaces`. Round-trips with
 * `convertLeadingTabsToSpaces` at the same width whenever the original
 * leading whitespace was already a whole number of `width`-column groups
 * (see lineops.test.ts) — a remainder is preserved as spaces either way, so
 * it round-trips too.
 */
export function convertLeadingSpacesToTabs(text: string, width: number): string {
  if (text === "") return "";
  const w = clampWidth(width);
  const { lines, trailingNewline } = splitLines(text);
  const converted = lines.map((line) => collapseLeadingIndentToTabs(line, w));
  return joinLines(converted, trailingNewline);
}

/**
 * Compute the `[from, to)` character span, expanded to whole lines, that a
 * line operation (Sort/Unique/Trim) should act on for a given non-empty
 * selection. Reimplements CodeMirror 6's own `Text.lineAt(pos)` line-
 * boundary rules over a plain string — a line's `.from`/`.to` are the
 * offsets of its first character and of its terminating "\n" respectively,
 * with the "\n" itself belonging to neither line — so this is unit-
 * testable without a WebView (see lineops.test.ts) while producing the
 * exact offsets `state.doc.lineAt` would for the same text.
 *
 * `from`/`to` must be CM6 `SelectionRange.from`/`.to`: already normalized
 * so `from <= to` regardless of which end of the selection the user
 * dragged from (`.anchor`/`.head` carry drag direction; `.from`/`.to`
 * never do), and `to` exclusive.
 *
 * The start line is resolved from `from` directly. The end line is
 * resolved from `to - 1` — the offset of the last character actually
 * inside the selection — never from `to` itself: when the selection's
 * exclusive end lands exactly at column 1 of the next line (i.e. right
 * after some line's newline, as when the user shift-selects through to
 * the start of the following line without touching any of its text),
 * resolving the end line from `to` would find that next line and pull the
 * whole thing into the span even though the user never selected any of it
 * (issue #99). `to - 1` always names a character inside the selection
 * here because `to > from` is required below, so `to - 1 >= from`.
 *
 * Not defined for an empty selection (`from === to`, a cursor): callers
 * give a cursor its own whole-document meaning instead of a line span
 * (see `EditorHandle.transformLines` in editor.ts), so this throws rather
 * than silently returning a nonsensical (possibly inverted) range.
 */
export function lineSpanForSelection(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  if (from === to) {
    throw new RangeError("lineSpanForSelection requires a non-empty selection (from !== to)");
  }
  return { from: lineStartAt(text, from), to: lineEndAt(text, to - 1) };
}

/** The `.from` CM6 would give the line containing `pos`: the offset right
 *  after the nearest preceding "\n", or 0 if `pos`'s line is the first.
 *  `pos` is handled as a special case rather than passed straight through
 *  to `lastIndexOf(..., pos - 1)`: at `pos === 0` that would become
 *  `lastIndexOf(..., -1)`, and a negative `lastIndexOf` search position is
 *  clamped to 0 (not "no match") per the language spec, which would
 *  wrongly report a newline "before" position 0 whenever `text` itself
 *  starts with one. */
function lineStartAt(text: string, pos: number): number {
  if (pos === 0) return 0;
  const newlineBefore = text.lastIndexOf("\n", pos - 1);
  return newlineBefore === -1 ? 0 : newlineBefore + 1;
}

/** The `.to` CM6 would give the line containing `pos`: the offset of the
 *  nearest following "\n" (a "\n" character's own string index is exactly
 *  the offset CM6 calls that line's `.to`), or `text.length` if `pos`'s
 *  line is the last. */
function lineEndAt(text: string, pos: number): number {
  const newlineAt = text.indexOf("\n", pos);
  return newlineAt === -1 ? text.length : newlineAt;
}
