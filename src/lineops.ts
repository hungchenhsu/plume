// Pure line-oriented text transforms for the Edit > Line Operations menu
// (ROADMAP.md Track C), plus `lineSpanForSelection`, the pure selection-
// boundary math `EditorHandle.transformLines` needs before it can call
// them. Nothing here touches CodeMirror or the DOM, so all of it is
// unit-testable without a WebView (see lineops.test.ts) and reusable from
// both `EditorHandle.transformLines` (line-boundary-expanded selection, or
// the whole document) and `EditorHandle.transformSelection` (selection
// verbatim, or the whole document) in editor.ts.
//
// Contract shared by the nine `(text: string) => string` transforms below
// (sortLines/sortLinesCaseInsensitive/sortLinesNumeric/uniqueLines/
// reverseLines/trimTrailingWhitespace/joinLines/upperCase/lowerCase): input
// and output are LF text (the editor buffer is always LF-normalized before
// it reaches the frontend — see CLAUDE.md "Hard constraints"), and an empty
// string maps to an empty string.
// `lineSpanForSelection`, at the end of this file, has a different shape —
// it returns character offsets, not text — because it answers a different
// question; see its own doc comment.

/**
 * Split LF text into its lines (terminators stripped) plus whether the
 * text ended with a trailing newline, so a transform that only reorders
 * or filters the line array can restore that trailing-newline presence
 * exactly via `linesToText`. Without tracking this separately, `"a\nb\n"`
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
 *  newline only when the original text had one. Named distinctly from the
 *  `joinLines` Edit > Line Operations transform below (ROADMAP.md v0.6
 *  C2) — that one merges a line array down to a single line's worth of
 *  *content*; this one is the plain structural inverse of `splitLines`,
 *  unrelated to the Join Lines feature beyond sharing an English verb. */
function linesToText(lines: readonly string[], trailingNewline: boolean): string {
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
  return linesToText(lines, trailingNewline);
}

/**
 * Sort lines case-insensitively (Edit > Line Operations' "Sort Lines
 * (Case-Insensitive)", ROADMAP.md v0.6 C3): the same `compareCodePoints`
 * comparison `sortLines` above uses — locale-independent and deterministic
 * across platforms, unlike `localeCompare` (see `compareCodePoints`'s own
 * doc comment) — applied to each line's `toLowerCase()` form instead of the
 * line itself, so `"Apple"`/`"apple"`/`"APPLE"` all compare equal.
 * `toLowerCase()` is JS's plain Unicode default case mapping, the same
 * primitive `lowerCase` below uses, not a locale-sensitive casing rule.
 * Lines that only differ by case (or are identical) keep their original
 * relative order — same `Array.prototype.sort` ES2019 stability guarantee
 * `sortLines` relies on — so sorting `["banana", "Apple", "apple"]` keeps
 * `"Apple"` before `"apple"` (input order), never picks one arbitrarily.
 * Trailing-newline presence is preserved, same as every transform in this
 * file.
 */
export function sortLinesCaseInsensitive(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  lines.sort((a, b) => compareCodePoints(a.toLowerCase(), b.toLowerCase()));
  return linesToText(lines, trailingNewline);
}

/**
 * Extract the first embedded number in `line` as a sort key for
 * `sortLinesNumeric` below, or `Infinity` if the line has no number at all
 * — pushing it after every real number when sorted ascending (the
 * "lines with no number sort last" rule; two such lines then keep their
 * relative order via `compareNumbers`'s stability, same as any other tie).
 *
 * The pattern is `-?\d+(?:\.\d+)?`: one or more digits, with an optional
 * leading `-` immediately adjacent to them (no intervening whitespace) read
 * as that number's sign, plus an optional `.` and more digits for a
 * decimal fraction. `String.prototype.match` (no `g` flag) finds the
 * leftmost position in `line` where this pattern matches at all, so:
 *
 * - `"pages 3-5"` extracts `3` (the first number, left to right), not `-5`.
 * - `"temp -5"` extracts `-5` — the `-` sits directly before the digit.
 * - `"a - 5"` (space before the digit) extracts `+5` — the `-` is not
 *   adjacent to a digit at that position, so it is never consumed as a
 *   sign; the match only succeeds once the scan reaches the digit itself.
 * - `"chapter-5"` extracts `-5` — the `-` is directly adjacent to `5`, so
 *   the same adjacency rule reads it as that number's sign, with no
 *   attempt to classify it as a word-separating hyphen from context.
 *   Deliberately simple, like the rest of this rule.
 *
 * A bare leading-dot decimal (`".5"`, no digit before the dot) is not
 * specially handled: `\d+` requires at least one digit before the optional
 * `.` group, so the leftmost match is just `"5"` (key `5`, not `0.5`) —
 * deliberately narrow, same spirit as `toHalfWidth`/`trimTrailingWhitespace`
 * elsewhere in this file only handling their own documented scope. A
 * multi-`.` string (e.g. a version like `"v1.2.3"`) similarly only ever
 * contributes its first `-?\d+(?:\.\d+)?` token (`"1.2"`), not a full
 * multi-segment parse.
 */
function firstNumberKey(line: string): number {
  const match = line.match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : Infinity;
}

/**
 * Comparator for `sortLinesNumeric`'s two `firstNumberKey` results. Equal
 * keys — including two `Infinity` "no number" sentinels — return exactly
 * `0` so `Array.prototype.sort`'s ES2019 stability guarantee preserves
 * their original relative order. Deliberately not a plain `a - b`:
 * subtracting two `Infinity` keys (two lines with no embedded number) would
 * produce `NaN`, and `Array.prototype.sort` does not guarantee to treat a
 * `NaN` comparator result as "equal" — exactly the kind of inconsistent,
 * platform-dependent comparator behavior `compareCodePoints`'s own doc
 * comment already avoids by not using `localeCompare`.
 */
function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sort lines by the first number embedded in each (Edit > Line Operations'
 * "Sort Lines (Numeric)", ROADMAP.md v0.6 C3) — see `firstNumberKey` for
 * the exact extraction rule. Lines with no number at all sort after every
 * line that has one; among lines that extract the same key (equal numbers,
 * or two number-less lines), `compareNumbers` returns exactly `0` so
 * `Array.prototype.sort`'s ES2019 stability guarantee keeps their relative
 * order — same tie-breaking contract `sortLines`/`sortLinesCaseInsensitive`
 * above already give. Trailing-newline presence is preserved, same as
 * every transform in this file.
 */
export function sortLinesNumeric(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  lines.sort((a, b) => compareNumbers(firstNumberKey(a), firstNumberKey(b)));
  return linesToText(lines, trailingNewline);
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
  return linesToText(kept, trailingNewline);
}

/**
 * Reverse the order of the lines in the given text — Edit > Line
 * Operations' "Reverse Lines" (ROADMAP.md v0.6 C2). No-selection scope
 * follows the same "no selection = whole document" convention `sortLines`/
 * `uniqueLines` above already use (via `EditorHandle.transformLines` in
 * editor.ts), so this is a plain `splitLines`/`linesToText` transform with
 * no span logic of its own, exactly like them. A trailing newline is a
 * property of the text as a whole, not a line of its own (see
 * `splitLines`'s doc comment), so it never itself moves: reversing
 * `"a\nb\nc\n"` gives `"c\nb\na\n"`, not `"\nc\nb\na"` — the trailing
 * newline stays trailing either way.
 */
export function reverseLines(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  lines.reverse();
  return linesToText(lines, trailingNewline);
}

/**
 * Trailing space/tab run at a line's end. Shared by `trimTrailingWhitespace`
 * (whole-string `String.replace`) and `trailingWhitespaceSpans` below
 * (position-tracking variant for editor.ts's save-time trim, ROADMAP.md v0.7
 * Track C) so the two can never disagree about what counts as trailing
 * whitespace to strip. Deliberately excludes `\r` — see
 * `trimTrailingWhitespace`'s own doc comment for why.
 */
const TRAILING_WHITESPACE = /[ \t]+$/;

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
  const trimmed = lines.map((line) => line.replace(TRAILING_WHITESPACE, ""));
  return linesToText(trimmed, trailingNewline);
}

/**
 * Character-offset `[from, to)` spans of every line's trailing space/tab run
 * in `text` — the position-tracking counterpart of `trimTrailingWhitespace`
 * above (same `TRAILING_WHITESPACE` rule, so the two can never disagree
 * about what to strip), built for editor.ts's save-time trim (ROADMAP.md
 * v0.7 Track C, "trim trailing whitespace on save").
 *
 * A CM6 transaction needs precise per-line `{from, to}` deletions rather
 * than a single whole-document replace (the way `EditorHandle.replaceContent`
 * works) for the feature's own caret-stability requirement: CM6's default
 * selection mapping leaves any position on an untouched line exactly where
 * it was, and collapses a position that *was* inside a deleted span onto
 * that span's `from` — which, since nothing is inserted back in a trimmed
 * span's place, is exactly the line's new end. A whole-document replace has
 * no such per-position correspondence between the old and new text, so
 * every cursor would instead land on one edge of the document (see
 * editor.ts's `trimTrailingWhitespaceOf` for where this is actually
 * dispatched, and its doc comment for the history/undo side of the same
 * design).
 *
 * A clean line contributes no span at all, not a zero-length one, so an
 * already-trimmed document returns `[]` — the empty-array "nothing to
 * trim" signal callers check before ever building a transaction. Offsets
 * are plain character (UTF-16 code unit) counts into `text` itself, the
 * same unit `lineSpanForSelection` above uses.
 */
export function trailingWhitespaceSpans(text: string): { from: number; to: number }[] {
  if (text === "") return [];
  const spans: { from: number; to: number }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = line.match(TRAILING_WHITESPACE);
    if (match) {
      const from = offset + match.index!;
      spans.push({ from, to: from + match[0].length });
    }
    offset += line.length + 1; // +1 for the "\n" this line was split on
  }
  return spans;
}

/**
 * Merge every line in the given text into a single line — Edit > Line
 * Operations' "Join Lines" (ROADMAP.md v0.6 C2). Mainstream editor
 * convention (VS Code, Sublime Text, Emacs): each subsequent line's
 * *leading* whitespace is stripped and the lines are rejoined with exactly
 * one space between them, so neither the removed newline nor whatever
 * indentation followed it survives as extra whitespace. A blank (or
 * whitespace-only) line contributes nothing at all — not even a space —
 * so joining across one never leaves a doubled space behind (e.g.
 * `"a\n\nb"` -> `"a b"`, not `"a  b"`). The first line's own leading
 * whitespace is left untouched (it is the resulting line's own
 * indentation, not a join seam), but a trailing-whitespace run already
 * accumulated so far *is* collapsed away before every join, so original
 * trailing whitespace on any line never stacks with the inserted join
 * space either (e.g. `"a   \nb"` -> `"a b"`, not `"a    b"`).
 *
 * Only `text`'s own lines are ever joined — deciding *which* lines make up
 * that span (the selection line-expanded, or the cursor's line plus the
 * next one when there is no selection) is `EditorHandle.joinLines`'s job
 * (editor.ts's `joinLinesSpanInDoc`), not this function's. A span of just
 * one line is therefore always a no-op here, regardless of why the caller
 * ended up with only one line.
 *
 * Deliberately narrow like `trimTrailingWhitespace` above: only space and
 * tab are treated as whitespace, never `\r` (see that function's doc
 * comment for why a stray one is left untouched rather than silently
 * eaten). Trailing-newline presence is preserved, same as every transform
 * in this file.
 */
export function joinLines(text: string): string {
  if (text === "") return "";
  const { lines, trailingNewline } = splitLines(text);
  if (lines.length <= 1) return text;
  let merged = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const stripped = lines[i].replace(/^[ \t]+/, "");
    merged = merged.replace(/[ \t]+$/, "");
    if (stripped === "") continue;
    merged += merged === "" ? stripped : ` ${stripped}`;
  }
  return linesToText([merged], trailingNewline);
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
  return linesToText(converted, trailingNewline);
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
  return linesToText(converted, trailingNewline);
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
