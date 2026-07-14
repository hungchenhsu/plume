// Curated audit of invisible/ambiguous Unicode characters that can
// misrepresent what a document's text actually says (ROADMAP.md v0.4
// Track A) — the sneakiest extension of this project's "never
// misrepresent user text" mandate (ARCHITECTURE.md), since these
// characters don't cause a decode error at all: the bytes are perfectly
// valid, they just don't mean what the rendered glyphs (or lack thereof)
// suggest. Three deliberately narrow groups, not "every Unicode format/
// control character":
//
//  - Bidirectional control characters (U+202A-U+202E, U+2066-U+2069, plus
//    ALM/LRM/RLM): U+202A-U+202E and U+2066-U+2069 are exactly the
//    characters the "Trojan Source" paper (Boucher & Anderson, 2021,
//    CVE-2021-42574 et al.) used to make source text *display* in an
//    order that doesn't match the bytes a compiler/interpreter/reader
//    actually processes.
//  - Zero-width characters: render nothing at all, so without this
//    feature their only visible trace is a subtly wrong cursor position
//    or word-wrap point.
//  - Whitespace variants that look like an ordinary space (or, for the
//    soft hyphen, nothing at all) but behave differently. U+3000
//    (ideographic space) is deliberately EXCLUDED: it is routine,
//    expected punctuation-width spacing in CJK text, not a disguised or
//    invisible character — see the "excludes U+3000" test in
//    suspiciouschars.test.ts.
//
// Pure module (no CM6 import), mirroring textstats.ts's split from
// editor.ts: this file owns the curated table and the scan function, both
// unit-tested directly against plain strings; editor.ts owns the
// CM6-specific glue (the `highlightSpecialChars` regex/render wiring, and
// the chunk-by-chunk `Text.iterRange` walk for the whole-document count).

export type SuspiciousCharCategory = "bidi" | "zeroWidth" | "whitespace";

export interface CuratedChar {
  codePoint: number;
  /** Short bracketed label rendered inline in the editor, e.g. "RLO" (see
   *  editor.ts's custom `highlightSpecialChars` render callback). */
  label: string;
  /** Full human-readable name, for tooltips/status text. */
  name: string;
  category: SuspiciousCharCategory;
}

/**
 * The audit list: 20 code points across the three groups above. Every
 * entry is commented with what it is; see the module doc comment for why
 * each *group* is here.
 *
 * CM6's own `basicSetup` already installs a default `highlightSpecialChars()`
 * that highlights (with a generic bullet-dot placeholder) a subset of
 * these — SHY, ALM, ZWSP, LRM, RLM, LRO, RLO, LRI, RLI, PDI, and in-body
 * BOM (verified from node_modules/@codemirror/view/dist/index.js's
 * `Specials` regexp) — but not LRE/RLE/PDF/FSI/ZWNJ/ZWJ/WJ/NBSP/NNBSP.
 * This table is the single source of truth for the *complete* curated set
 * regardless of that overlap: editor.ts derives its `addSpecialChars`
 * pattern from every entry here (not just the ones CM6 doesn't already
 * cover), so the rendered label and the counted total can never drift
 * apart from each other.
 */
export const CURATED_CHARS: readonly CuratedChar[] = [
  // ---- Bidirectional control characters.
  { codePoint: 0x202a, label: "LRE", name: "Left-to-Right Embedding", category: "bidi" },
  { codePoint: 0x202b, label: "RLE", name: "Right-to-Left Embedding", category: "bidi" },
  { codePoint: 0x202c, label: "PDF", name: "Pop Directional Formatting", category: "bidi" },
  { codePoint: 0x202d, label: "LRO", name: "Left-to-Right Override", category: "bidi" },
  { codePoint: 0x202e, label: "RLO", name: "Right-to-Left Override", category: "bidi" },
  { codePoint: 0x2066, label: "LRI", name: "Left-to-Right Isolate", category: "bidi" },
  { codePoint: 0x2067, label: "RLI", name: "Right-to-Left Isolate", category: "bidi" },
  { codePoint: 0x2068, label: "FSI", name: "First Strong Isolate", category: "bidi" },
  { codePoint: 0x2069, label: "PDI", name: "Pop Directional Isolate", category: "bidi" },
  { codePoint: 0x061c, label: "ALM", name: "Arabic Letter Mark", category: "bidi" },
  { codePoint: 0x200e, label: "LRM", name: "Left-to-Right Mark", category: "bidi" },
  { codePoint: 0x200f, label: "RLM", name: "Right-to-Left Mark", category: "bidi" },

  // ---- Zero-width characters.
  { codePoint: 0x200b, label: "ZWSP", name: "Zero Width Space", category: "zeroWidth" },
  { codePoint: 0x200c, label: "ZWNJ", name: "Zero Width Non-Joiner", category: "zeroWidth" },
  { codePoint: 0x200d, label: "ZWJ", name: "Zero Width Joiner", category: "zeroWidth" },
  { codePoint: 0x2060, label: "WJ", name: "Word Joiner", category: "zeroWidth" },
  // U+FEFF *in the body* of a document, not a file's own leading BOM: the
  // Rust core strips a file-level BOM before content ever crosses IPC,
  // surfacing it instead as the `withBom` metadata flag (see
  // ARCHITECTURE.md's raw-bytes-never-cross-IPC constraint) — so any
  // U+FEFF this scan finds is genuinely mid-document (e.g. pasted or
  // concatenated content) and would otherwise render as an invisible gap.
  { codePoint: 0xfeff, label: "BOM", name: "Byte Order Mark (in body)", category: "zeroWidth" },

  // ---- Whitespace variants.
  { codePoint: 0x00a0, label: "NBSP", name: "No-Break Space", category: "whitespace" },
  { codePoint: 0x202f, label: "NNBSP", name: "Narrow No-Break Space", category: "whitespace" },
  { codePoint: 0x00ad, label: "SHY", name: "Soft Hyphen", category: "whitespace" },
];

const CURATED_BY_CODE: ReadonlyMap<number, CuratedChar> = new Map(
  CURATED_CHARS.map((entry) => [entry.codePoint, entry]),
);

/** Look up a UTF-16 code unit (equivalently, a code point — every curated
 *  entry fits in one UTF-16 code unit, see `scanSuspiciousChars`'s doc
 *  comment) against the curated table. */
export function suspiciousCharFor(codeUnit: number): CuratedChar | undefined {
  return CURATED_BY_CODE.get(codeUnit);
}

export interface SuspiciousCharHit {
  /** Offset within the scanned string/chunk (UTF-16 code units) — exposed
   *  for testability and a possible future "jump to next" action, even
   *  though the current status-bar UI (main.ts/statusbar.ts) only
   *  surfaces a count (ROADMAP.md v0.4 Track A explicitly allows narrowing
   *  scope to count-only). */
  offset: number;
  char: string;
  label: string;
  name: string;
  category: SuspiciousCharCategory;
}

/**
 * Scan one string — a whole document, or one `Text.iterRange` chunk, see
 * editor.ts's `suspiciousCharCountOf` — for curated characters, returning
 * every hit with its offset *within this string*.
 *
 * Every curated code point fits in one UTF-16 code unit (all 20 are in the
 * Basic Multilingual Plane; none is in the D800-DFFF surrogate range), so
 * a plain `charCodeAt` scan is always correct here: a supplementary-plane
 * character (a surrogate pair, e.g. an emoji) is two code units that can
 * never individually equal a curated code point, so it is safely skipped
 * over — whole, half, or split across a chunk boundary makes no
 * difference. This is unlike textstats.ts's word/char counter, which has
 * to carry a pending high surrogate across chunks specifically because
 * *it* cares about not double-counting a supplementary character split at
 * a boundary — nothing here needs that: this function carries no state
 * across calls, so callers can feed it chunks in any order and just sum
 * `.length` (see editor.ts's `suspiciousCharCountOf`).
 */
export function scanSuspiciousChars(text: string): SuspiciousCharHit[] {
  const hits: SuspiciousCharHit[] = [];
  for (let i = 0; i < text.length; i++) {
    const entry = CURATED_BY_CODE.get(text.charCodeAt(i));
    if (entry) {
      hits.push({
        offset: i,
        char: text[i],
        label: entry.label,
        name: entry.name,
        category: entry.category,
      });
    }
  }
  return hits;
}

/**
 * A single regex matching every curated code point, as a 4-hex-digit
 * `\uXXXX` escape per entry (every code point is <= 0xFFFF, so this
 * classic escape form always applies — no need for the `\u{...}` extended
 * syntax that only matters above the Basic Multilingual Plane). This is
 * the one source editor.ts's `highlightSpecialChars({ addSpecialChars })`
 * config derives its pattern from, so the *rendered* set (bracket labels)
 * and the *counted* set (this module's scan functions, above) can never
 * drift apart. No flags: CM6's own facet-combine step only ever reads
 * `.source` off this RegExp and recompiles it with its own flags (see
 * editor.ts's doc comment on the overlay), so flags set here would be
 * discarded anyway.
 */
export const SUSPICIOUS_CHARS_PATTERN = new RegExp(
  `[${CURATED_CHARS.map((entry) => `\\u${entry.codePoint.toString(16).padStart(4, "0")}`).join("")}]`,
);
