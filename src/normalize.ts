// Unicode normalization: pure detection and impact-analysis helpers for
// Edit > Normalize to NFC/NFD (ROADMAP.md v0.4 Track A) [danger]. Split from
// the CM6 plumbing in editor.ts's `isNonNfcOf` (mirrors textstats.ts's own
// module-doc rationale): this file only knows about strings and iterables
// of strings, so it is unit-testable without a WebView (see
// normalize.test.ts).
//
// The core risk this whole feature exists to guard against: NFD's
// decomposed combining sequences are frequently unrepresentable in legacy
// encodings (Big5, Shift_JIS, ...) even when the precomposed NFC form was
// fine. Normalizing must never quietly set up a lossy save — this module
// only detects and measures; main.ts's normalize flow runs `planNormalization`
// below and then a Rust representability dry-run
// (src-tauri/src/normalize.rs via ipc.ts's `checkRepresentable`, mirroring
// `save_document`'s own lossy-encode gate) *before* ever applying the
// transform to the live buffer.

export type NormalizeForm = "NFC" | "NFD";

/** True when `text` already equals its own `form`-normalized form. Ground
 *  truth every chunked/incremental helper below must agree with for any way
 *  of splitting the same string into chunks (see normalize.test.ts's
 *  split-invariance suite). */
export function isNormalized(text: string, form: NormalizeForm): boolean {
  return text === text.normalize(form);
}

/** NFC convenience wrapper — the common case (`isNormalized(text, "NFC")`),
 *  used by the status-bar "non-NFC" marker (editor.ts's `isNonNfcOf`). */
export function isNfc(text: string): boolean {
  return isNormalized(text, "NFC");
}

// The unit this module must never split is the span between two
// "normalization boundaries" (the UAX #15 / ICU `hasBoundaryBefore`
// concept): a boundary exists before a code point iff canonical
// normalization can never merge it with, or reorder it around, anything
// that precedes it. `canMergeWithPreceding` below is the complement — true
// for every code point with NO boundary before it — built from two parts:
//
// - `\p{M}` (Unicode general category Mark, via a native ES2018 property
//   escape — no new dependency, no TypeScript `lib` bump, unlike
//   `Intl.Segmenter`'s ES2022.Intl types). This covers every code point
//   with a non-zero canonical combining class (all such code points are
//   Marks) plus the ccc=0 spacing marks (Mc) that occur as the second
//   element of canonical composition pairs (e.g. U+09BE, which composes
//   onto U+09C7).
// - The known non-Mark canonical-composition second elements — letters
//   (general category Lo) that nevertheless compose onto what precedes
//   them, which a `\p{M}`-only predicate would treat as fresh starters,
//   flushing their base away and misreporting decomposed text as already
//   normalized even in a single chunk (the faulty split happens in this
//   module's own carry logic, not at a caller's chunk boundary —
//   adversarial-review finding; see normalize.test.ts's Hangul cases). As
//   of Unicode 16.0 this set is exactly:
//     - Conjoining Hangul jamo in *algorithmic* composition: medial
//       vowels V (U+1161-U+1175, compose onto a preceding leading
//       consonant L) and trailing consonants T (U+11A8-U+11C2, compose
//       onto a preceding LV syllable). The extended jamo blocks
//       (U+A960-, U+D7B0-) do not algorithmically compose and are
//       deliberately excluded.
//     - U+16D67 KIRAT RAI VOWEL SIGN AAI (added in Unicode 16.0): the
//       second element of U+16D68/U+16D69/U+16D6A's canonical
//       compositions — found by the planes-0-2 sweep below, not by
//       reading the standard.
//   Maintenance contract: this list is version-pinned by construction —
//   normalize.test.ts's exhaustive sweep derives the ground truth from
//   the runtime's own `String.prototype.normalize` over every
//   decomposable code point in planes 0-2 (all canonical decompositions
//   live there), so a future Unicode version introducing another
//   non-Mark second element fails that sweep loudly, naming the exact
//   code point to add here, rather than silently misdetecting. Caveat:
//   "loudly" holds only when the test runtime's ICU is at least as new
//   as the user's WebView ICU — a newly *assigned* character that only
//   the user's newer ICU decomposes would slip past the sweep (the
//   stability policy pins already-assigned characters forever, so the
//   skew window is new assignments only, and the impact ceiling is a
//   missed status marker, never data loss).
//
// Deliberately NOT full grapheme-cluster segmentation (UAX #29): clusters
// also glue ZWJ emoji sequences, regional-indicator pairs, etc., which
// canonical normalization never touches — boundaries here only need to be
// safe for NFC/NFD. That safety is pinned empirically, not by assertion,
// by the same sweep.
const COMBINING_MARK = /\p{M}/u;

function canMergeWithPreceding(ch: string): boolean {
  if (COMBINING_MARK.test(ch)) return true;
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x1161 && cp <= 0x1175) || // Hangul V jamo
    (cp >= 0x11a8 && cp <= 0x11c2) || // Hangul T jamo
    cp === 0x16d67 // KIRAT RAI VOWEL SIGN AAI (Unicode 16.0)
  );
}

/** A single UTF-16 high-surrogate code unit with no low surrogate after it
 *  — `Array.from`'s code-point iteration yields it as its own one-unit
 *  token. Only ever seen at the very end of a buffer whose chunk boundary
 *  landed inside a surrogate pair (concatenating the next chunk reunites
 *  the pair before anything is judged). */
function isLoneHighSurrogate(token: string): boolean {
  if (token.length !== 1) return false;
  const unit = token.charCodeAt(0);
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Split `buffer` (iterated by Unicode code point, so a supplementary-plane
 * character/surrogate pair is never split — same technique lineops.ts's
 * `compareCodePoints`/`toHalfWidth` use) at the last normalization
 * boundary: the last code point that cannot merge with what precedes it (a
 * "starter" — see `canMergeWithPreceding` above), together with everything
 * after it. `flushed` is everything before that point (safe to finalize
 * now), `carry` is the rest (always held back, even if it is just one
 * plain character) — see `isNormalizedChunked`'s doc comment for why the
 * *tail* of any buffer-so-far can never be judged complete on its own
 * (more combining marks / conjoining jamo, or a surrogate pair's other
 * half, might still be coming in the next chunk). If `buffer` has no
 * starter at all (every code point can merge with a predecessor, e.g. a
 * chunk consisting only of stray marks), nothing is flushed.
 *
 * A trailing lone high surrogate (a chunk boundary landed mid-pair) is
 * never a cut point either: until its low surrogate arrives, the code
 * point's identity — combining mark or starter — is unknowable, and astral
 * combining marks are real (e.g. U+110BA, plane-1 Mn, the second half of
 * U+1109A's decomposition). Cutting at the incomplete unit would flush the
 * preceding base away from a mark that may still be about to complete —
 * exactly the premature-flush bug the surrogate-split sweep in
 * normalize.test.ts pins. The scan simply keeps walking past it to the
 * real starter, so the incomplete unit rides along in `carry` with its
 * potential base.
 */
function splitAtLastStarter(buffer: string): { flushed: string; carry: string } {
  if (buffer === "") return { flushed: "", carry: "" };
  const codePoints = Array.from(buffer);
  let cut = -1;
  for (let i = codePoints.length - 1; i >= 0; i--) {
    const token = codePoints[i];
    if (!canMergeWithPreceding(token) && !isLoneHighSurrogate(token)) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return { flushed: "", carry: buffer };
  return {
    flushed: codePoints.slice(0, cut).join(""),
    carry: codePoints.slice(cut).join(""),
  };
}

/**
 * Chunk-boundary-safe incremental non-normalized detection, for callers
 * (the live editor buffer) that can hand over a document's text as a
 * sequence of chunks — e.g. CodeMirror 6's `Text.iter()` — without first
 * concatenating them into one big string via `doc.toString()`. Returns
 * true iff the *concatenation* of all chunks already equals its own
 * `form`-normalized form, agreeing with `isNormalized(chunks.join(""),
 * form)` for every possible way of splitting the same string into chunks
 * (verified exhaustively over every split point of representative fixtures
 * in normalize.test.ts, not just a couple of hand-picked cases).
 *
 * Correctness hazard this exists to avoid: a chunk boundary can fall inside
 * a combining character sequence — a base character followed by one or
 * more combining marks. Checking each chunk's normalization in isolation
 * would then either wrongly flag a clean split as non-normalized, or —
 * worse — silently *miss* a real non-normalized sequence that only becomes
 * apparent once the following chunk's combining mark is considered: a chunk
 * boundary landing exactly between "e" and a combining acute accent means
 * neither "...e" nor "́..." looks abnormal checked on its own, but
 * together they are the NFD form of "é" and must be reported as non-NFC.
 * (normalize.test.ts pins exactly this case, including a naive
 * check-every-chunk-independently comparison that gets it wrong, to prove
 * this isn't a hypothetical risk.)
 *
 * Fix: buffer text across chunk boundaries and only check-and-discard a
 * prefix up to the last safe cut point (`splitAtLastStarter`). The final
 * normalization-boundary sequence of whatever's accumulated so far is
 * *always* carried into the next round regardless of what it looks like in
 * isolation — including a trailing lone high surrogate, which is never a
 * cut point (see `splitAtLastStarter`'s doc comment) and rides along in
 * the carry with its potential base until the next chunk's low surrogate
 * reunites the pair, at which point the completed code point is judged
 * normally (both the BMP and the astral surrogate-split cases are pinned
 * in normalize.test.ts).
 *
 * In production this feeds from CM6's `Text.iter()` (see editor.ts's
 * `isNonNfcOf`), whose *own* internal chunk boundaries are always whole
 * lines or lone line breaks — verified empirically against
 * `@codemirror/state`'s actual behavior, the same way textstats.ts's
 * `accumulateChunk` documents `Text.iterRange`'s chunking. A combining
 * sequence never spans a hard line break in well-formed text, so real usage
 * essentially never exercises the carry logic beyond one trailing
 * character. This function still doesn't assume that: it stays correct for
 * an arbitrary chunking, the same defense-in-depth textstats.ts's own
 * `pendingHighSurrogate` guard applies for exactly the same reason (stays
 * correct if this is ever fed a different, less line-aligned chunk source).
 */
export function isNormalizedChunked(
  chunks: Iterable<string>,
  form: NormalizeForm,
): boolean {
  let carry = "";
  for (const chunk of chunks) {
    const buffer = carry + chunk;
    const { flushed, carry: rest } = splitAtLastStarter(buffer);
    if (flushed !== "" && !isNormalized(flushed, form)) return false;
    carry = rest;
  }
  return isNormalized(carry, form);
}

/** NFC convenience wrapper of `isNormalizedChunked` — the one actually
 *  wired to the status-bar marker (editor.ts's `isNonNfcOf`). */
export function isNfcChunked(chunks: Iterable<string>): boolean {
  return isNormalizedChunked(chunks, "NFC");
}

/**
 * Split `text` into normalization-boundary-delimited sequences — a
 * "starter" (any code point that cannot merge with what precedes it)
 * followed by every immediately following mergeable code point (combining
 * marks, conjoining V/T jamo), iterated by code point. The same boundary
 * concept `splitAtLastStarter` above uses for streaming chunk-boundary
 * safety, applied here instead to divide a whole string into comparable
 * units for `countChangedSequences` — so an NFD Hangul syllable (L+V or
 * L+V+T) counts as ONE sequence, matching what its precomposed form counts
 * as. A leading run of mergeable code points with no preceding starter at
 * all becomes its own (unusual, but well-defined) sequence.
 */
function splitIntoSequences(text: string): string[] {
  const sequences: string[] = [];
  let current = "";
  for (const ch of text) {
    if (canMergeWithPreceding(ch) && current !== "") {
      current += ch;
    } else {
      if (current !== "") sequences.push(current);
      current = ch;
    }
  }
  if (current !== "") sequences.push(current);
  return sequences;
}

/**
 * Count how many normalization-boundary sequences actually differ between
 * `original` and `normalized` (expected to be `original.normalize(form)`
 * for some form — see `planNormalization`) — the "N sequences will change"
 * figure shown in the Normalize confirm dialog (ROADMAP.md v0.4 Track A),
 * deliberately not a raw code-point diff count: composition/decomposition
 * changes how many *code points* encode one user-perceived character (NFD
 * splits "é" U+00E9 into "e" + U+0301, one code point becoming two), so a
 * position-by-position code-point count would misalign after the first
 * change, or double-count one visual character as two.
 *
 * Canonical normalization (NFC/NFD — unlike the compatibility forms
 * NFKC/NFKD this feature does not offer) never merges or splits a
 * normalization-boundary sequence into/out of another one, only changes
 * its internal representation within itself (the same invariant
 * `isNormalizedChunked` relies on for chunk-boundary safety — and the
 * reason `splitIntoSequences` must treat conjoining V/T jamo as sequence
 * extenders: under a `\p{M}`-only split, NFD "가" was 2 sequences to NFC
 * "가"'s 1, forcing the coarse fallback below where the true per-syllable
 * answer was available). So `original` and `normalized` always split into
 * the same number of sequences in the same order and a pairwise comparison
 * is always well-defined — exercised directly in normalize.test.ts's
 * fixtures (Latin and Hangul, both directions) rather than assumed
 * silently.
 *
 * Defensive fallback: if the sequence counts ever *do* disagree for some
 * input this reasoning didn't anticipate, this returns `1` whenever
 * `normalized !== original` — a coarse "something changed" signal — rather
 * than indexing out of bounds or misreporting. The representability guard
 * (Rust `check_representable`) is unaffected either way; only this dialog's
 * sequence count would be conservative.
 */
export function countChangedSequences(original: string, normalized: string): number {
  if (original === normalized) return 0;
  const originalSeqs = splitIntoSequences(original);
  const normalizedSeqs = splitIntoSequences(normalized);
  if (originalSeqs.length !== normalizedSeqs.length) return 1;
  let count = 0;
  for (let i = 0; i < originalSeqs.length; i++) {
    if (originalSeqs[i] !== normalizedSeqs[i]) count++;
  }
  return count;
}

/** Pure decision result for the Normalize confirm flow (main.ts): whether
 *  there's anything to do at all, and if so, how many sequences would
 *  change — computed once so the confirm dialog and the eventual apply
 *  both act on the exact same normalized text. */
export interface NormalizePlan {
  form: NormalizeForm;
  normalized: string;
  changed: boolean;
  changedCount: number;
}

/**
 * The pure decision part of Edit > Normalize to NFC/NFD (ROADMAP.md v0.4
 * Track A): normalize `text` to `form` and report whether anything actually
 * changed (a no-op run, like the existing sort/trim/case-conversion Line
 * Operations, should apply nothing and show no dialog — see main.ts's
 * `runNormalizeFlow`) plus how many combining-character sequences differ,
 * for the confirm dialog's "N sequences will change" message.
 */
export function planNormalization(text: string, form: NormalizeForm): NormalizePlan {
  const normalized = text.normalize(form);
  const changed = normalized !== text;
  return {
    form,
    normalized,
    changed,
    changedCount: changed ? countChangedSequences(text, normalized) : 0,
  };
}
