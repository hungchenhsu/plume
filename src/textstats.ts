// Pure word/char/line counting for the status-bar text-stats segment
// (ROADMAP.md v0.4 Track C). Deliberately split from the CM6 plumbing in
// editor.ts's `textStatsOf`: this file only knows about strings, so it is
// unit-testable without a WebView (see textstats.test.ts), and reusable
// for both the whole document and a bounded selection range.
//
// Word definition (CJK-aware): every CJK Unified Ideograph (including
// Extension A), Hiragana/Katakana kana character, and Hangul syllable
// counts as its own word — there is no whitespace to split on, and
// dictionary-based segmentation would be a real NLP dependency this
// project's "no new runtime dependencies" constraint (CLAUDE.md) rules
// out. This matches how CJK word counters conventionally work. Everything
// else is grouped into runs of Unicode letters/numbers (`\p{L}`/`\p{N}`),
// same as a typical Western word count.
//
// Character counts are Unicode code points, not UTF-16 code units, so a
// single emoji (or any other supplementary-plane character, encoded as a
// surrogate pair) counts as one character, not two.

export interface TextStats {
  chars: number;
  words: number;
  lines: number;
}

// CJK ranges that count as one word per character (see module doc comment
// above). Deliberately narrow to exactly what ROADMAP.md's spec calls out:
// CJK Unified Ideographs + Extension A (not the supplementary-plane
// Extensions B-G), Hiragana + Katakana, and the Hangul syllable block.
function isCjkChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0xac00 && cp <= 0xd7a3) // Hangul syllables
  );
}

function isAsciiWordChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) // a-z
  );
}

// Fallback for the rare non-ASCII, non-CJK code point (accented Latin,
// Cyrillic, Greek, Arabic digits, etc.) — only reached when the two cheap
// range checks above both miss, so this regex cost is paid on a small
// minority of real-world text. `\p{L}`/`\p{N}` (Unicode property escapes,
// `u` flag) match any Unicode letter or number, mirroring lineops.ts's own
// reasoning for operating on code points rather than UTF-16 units.
const OTHER_WORD_CHAR = /[\p{L}\p{N}]/u;
function isOtherWordChar(cp: number): boolean {
  return OTHER_WORD_CHAR.test(String.fromCodePoint(cp));
}

/**
 * Streaming state for counting chars/words/lines across successive text
 * chunks without ever concatenating them into one string (see editor.ts's
 * `textStatsOf`, which feeds this one `Text.iterRange` chunk at a time so
 * the document is never materialized via `doc.toString()` — issue #107's
 * anti-pattern). Two bits of state carry across chunk boundaries:
 *
 * - `inWordRun`: whether the previous chunk's last code point was a
 *   non-CJK word character, so a word character at the very start of the
 *   next chunk continues that run instead of starting a new word.
 * - `pendingHighSurrogate`: a trailing unpaired UTF-16 high surrogate
 *   (U+D800-U+DBFF) at the end of a chunk, held back and prepended to the
 *   next chunk rather than treated as its own (invalid) code point.
 *
 * `Text.iterRange` never actually splits a word or a surrogate pair across
 * an *internal* chunk boundary — verified against @codemirror/state's own
 * source (`TextLeaf`/`RawTextCursor`/`PartialTextCursor`): a `TextLeaf`
 * stores each line as one complete, unsplit string, so every yielded chunk
 * is either a whole line, a line break, or (only at the very start/end of
 * the requested range) that range's own boundary-trimmed partial line. But
 * that boundary trim means a caller-chosen `from`/`to` landing inside a
 * surrogate pair *would* split it there, so this still guards for it
 * rather than assuming CM6-internal chunking is the only thing that
 * matters (in practice CM6 keeps user-driven selections off such
 * boundaries, but this accumulator doesn't need to assume that holds).
 */
export interface TextStatsAccumulator {
  chars: number;
  words: number;
  newlines: number;
  inWordRun: boolean;
  pendingHighSurrogate: string;
  /** True if the most recently processed code point was "\n" — used by
   *  `finishRangeTextStats` to tell a range's own trailing line break
   *  apart from one that would open a further line (see its doc comment). */
  lastWasNewline: boolean;
}

export function createTextStatsAccumulator(): TextStatsAccumulator {
  return {
    chars: 0,
    words: 0,
    newlines: 0,
    inWordRun: false,
    pendingHighSurrogate: "",
    lastWasNewline: false,
  };
}

/** Feed one more chunk of text into the accumulator, in document order. */
export function accumulateChunk(acc: TextStatsAccumulator, chunk: string): void {
  const text = acc.pendingHighSurrogate + chunk;
  acc.pendingHighSurrogate = "";
  let end = text.length;
  if (end > 0) {
    const lastUnit = text.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      // Unpaired high surrogate at the very end of what we have so far —
      // hold it back in case the next chunk supplies its low surrogate.
      acc.pendingHighSurrogate = text[end - 1];
      end -= 1;
    }
  }
  let i = 0;
  while (i < end) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    acc.chars++;
    acc.lastWasNewline = cp === 0x0a;
    if (cp === 0x0a) {
      acc.newlines++;
      acc.inWordRun = false;
    } else if (isCjkChar(cp)) {
      acc.words++;
      acc.inWordRun = false;
    } else if (isAsciiWordChar(cp) || (cp > 0x7f && isOtherWordChar(cp))) {
      if (!acc.inWordRun) acc.words++;
      acc.inWordRun = true;
    } else {
      acc.inWordRun = false;
    }
  }
}

/** Finalize a whole-document (or otherwise line-aligned) span: a trailing
 *  newline opens one further, empty line — matching CM6's own `Text.lines`
 *  convention (`Text.of(["a", ""])`, i.e. `"a\n"`, has 2 lines).
 *
 *  A `pendingHighSurrogate` still held at this point means input ended
 *  right after an unpaired high surrogate (no low surrogate ever arrived
 *  to complete it) — it is still one UTF-16 code unit of real content, so
 *  it counts as one character here, even though it never contributed to
 *  `words` (it is neither CJK nor `\p{L}`/`\p{N}` on its own). */
export function finishTextStats(acc: TextStatsAccumulator): TextStats {
  const chars = acc.chars + (acc.pendingHighSurrogate ? 1 : 0);
  return { chars, words: acc.words, lines: acc.newlines + 1 };
}

/** Finalize an arbitrary `[from, to)` sub-range (a selection): a newline
 *  that is the range's own last character closes off the line it's on
 *  rather than opening a further one the selection never actually reaches
 *  — mirrors editor.ts's `lineSpanForSelectionInDoc` / lineops.ts's
 *  `lineSpanForSelection`, which resolve a selection's end line from
 *  `to - 1` for the exact same reason (issue #99). Without this
 *  correction, selecting exactly through a line's trailing newline (and no
 *  further) would report 2 lines spanned instead of 1. */
export function finishRangeTextStats(acc: TextStatsAccumulator): TextStats {
  const base = finishTextStats(acc);
  return {
    ...base,
    lines: acc.lastWasNewline ? Math.max(1, base.lines - 1) : base.lines,
  };
}

/** Non-streaming convenience wrapper for a single complete string —
 *  equivalent to accumulating it as one chunk, treated as its own whole
 *  document (see `finishTextStats`). Used directly by tests and by
 *  anything that already has a plain string in hand. */
export function countTextStats(text: string): TextStats {
  const acc = createTextStatsAccumulator();
  accumulateChunk(acc, text);
  return finishTextStats(acc);
}
