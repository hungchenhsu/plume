// Pure indentation-style detection for the status-bar indentation segment
// and CM6's indentUnit/tabSize wiring (ROADMAP.md v0.4 Track C). Like
// textstats.ts/lineops.ts, this file only knows about plain strings, so it
// is unit-testable without a WebView (see indentdetect.test.ts) and reusable
// from the CM6-facing wrapper in editor.ts (`detectIndentationOf`, which
// samples a live buffer's lines via `Text.iterLines` and hands them here —
// see that function's doc comment for the sampling policy).
//
// Detection heuristic ("classic": mode of adjacent indent-depth diffs):
// walk the given lines in order, skipping blank (whitespace-only) ones —
// same convention as editor.ts's `indentGuideLevels` (a blank line carries
// no indentation signal of its own). For every other line, look only at its
// *leading* run of spaces/tabs (interior and trailing content never affect
// detection):
//
// - A leading run containing both spaces and tabs (in either order, e.g.
//   "   \tx" or "\t   x") is unambiguous evidence of "mixed" — a single such
//   line is enough to decide the whole document, regardless of what any
//   other line looks like.
// - A leading run of only tabs marks the line as tab-indented; a leading
//   run of only spaces (zero or more — zero counts as an unindented
//   "anchor" line, see below) marks it as space-indented.
// - If the document has both tab-indented and space-indented lines (even
//   with no single mixed-within-a-line offender), that inconsistency is
//   also "mixed".
// - Tabs-only (no space-indented line anywhere) is "tabs" — a tab's visual
//   width can never be inferred from the tab characters themselves (unlike
//   a space run's length), so no width is reported; editor.ts's
//   `setIndentation` falls back to the user's preference default for
//   `tabSize` in this case, same as "mixed"/"none".
// - No indentation anywhere (every non-blank line has depth 0, i.e. no
//   leading whitespace at all) is "none" — this also covers an empty
//   document (a single empty line) and an all-blank document.
// - Otherwise ("spaces"): every space-indented line's depth (its leading
//   space count — a depth-0 unindented line counts too, as the baseline
//   most files dedent back to) is compared against the previous such line
//   in document order; each time the depth actually changes, the absolute
//   difference is tallied. The *mode* (most frequent diff) is the detected
//   width — not the first or largest diff — so a single deeper jump (e.g. a
//   pasted, already-nested block) doesn't outvote a document's otherwise
//   consistent step. A tie between equally-frequent diffs picks the
//   smaller width, deterministically. When no diff is computable at all
//   (every space-indented line shares one identical depth, e.g. a single
//   indented line with no depth-0 baseline anywhere in the sample), the
//   smallest observed positive depth is used as the width instead — the
//   simplest consistent assumption ("this many spaces is one level") when
//   there is no variation to measure a step from.
//
// A blank line never breaks this diff chain: the previous non-blank line's
// depth carries across it unchanged, so e.g. a blank line between a
// function's opening brace and its first statement doesn't hide that
// pair's indent step. A tab-indented or mixed-within-line line, by
// contrast, is simply skipped for the *diff* computation (its presence
// already forces the overall result to "tabs"/"mixed" via the flags above,
// so no document ever reaches the "spaces" branch while such a line
// exists — the diff chain across it is therefore never actually observed
// in the returned result).

export type IndentKind = "spaces" | "tabs" | "mixed" | "none";

/**
 * Detected indentation style for a document (or a sampled window of one —
 * see editor.ts's `detectIndentationOf`). `width` is only present (and only
 * meaningful) for `"spaces"`: a tab's rendered width is a display
 * preference, not something the tab characters themselves encode, so
 * "tabs"/"mixed"/"none" never carry one — see this module's header comment.
 */
export type IndentInfo =
  | { kind: "spaces"; width: number }
  | { kind: "tabs" }
  | { kind: "mixed" }
  | { kind: "none" };

/** Count of leading spaces/tabs at the start of `line`, stopping at the
 *  first non-whitespace character — same leading-run scan as editor.ts's
 *  `indentGuideLevels`, just counting each character kind instead of a
 *  column width. */
function leadingWhitespace(line: string): { spaces: number; tabs: number } {
  let spaces = 0;
  let tabs = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") spaces++;
    else if (line[i] === "\t") tabs++;
    else break;
    i++;
  }
  return { spaces, tabs };
}

/** The most frequent value in `diffCounts` (key = diff, value = frequency),
 *  or `null` if it's empty. Ties are broken by picking the smaller diff,
 *  deterministically — `diffCounts` is a `Map`, whose iteration order is
 *  insertion order, not numeric order, so keys are sorted ascending first. */
function modeOfDiffs(diffCounts: Map<number, number>): number | null {
  let bestDiff: number | null = null;
  let bestCount = 0;
  for (const diff of [...diffCounts.keys()].sort((a, b) => a - b)) {
    const count = diffCounts.get(diff)!;
    if (count > bestCount) {
      bestCount = count;
      bestDiff = diff;
    }
  }
  return bestDiff;
}

/** Detect the indentation style of `lines` (already split, no line-break
 *  characters — see editor.ts's `detectIndentationOf` for how a live CM6
 *  buffer's lines are sampled into this shape). See this module's header
 *  comment for the full heuristic. */
export function detectIndentation(lines: readonly string[]): IndentInfo {
  let hasSpaceIndent = false;
  let hasTabIndent = false;
  let hasMixedLine = false;
  let previousDepth: number | null = null;
  let minPositiveDepth: number | null = null;
  const diffCounts = new Map<number, number>();

  for (const line of lines) {
    if (line.trim() === "") continue; // blank: no signal, chain unaffected

    const { spaces, tabs } = leadingWhitespace(line);

    if (spaces > 0 && tabs > 0) {
      hasMixedLine = true;
      continue;
    }
    if (tabs > 0) {
      hasTabIndent = true;
      continue;
    }

    // Spaces only from here on (tabs === 0); `spaces` may be 0 (an
    // unindented anchor line — still useful as a diff baseline below).
    if (spaces > 0) {
      hasSpaceIndent = true;
      if (minPositiveDepth === null || spaces < minPositiveDepth) {
        minPositiveDepth = spaces;
      }
    }
    if (previousDepth !== null && previousDepth !== spaces) {
      const diff = Math.abs(spaces - previousDepth);
      diffCounts.set(diff, (diffCounts.get(diff) ?? 0) + 1);
    }
    previousDepth = spaces;
  }

  if (hasMixedLine || (hasSpaceIndent && hasTabIndent)) return { kind: "mixed" };
  if (hasTabIndent) return { kind: "tabs" };
  if (!hasSpaceIndent) return { kind: "none" };

  // hasSpaceIndent guarantees minPositiveDepth was set (every branch that
  // sets one also sets the other); the `?? 4` is an unreachable defensive
  // fallback only, kept so this needs no non-null assertion.
  const width = modeOfDiffs(diffCounts) ?? minPositiveDepth ?? 4;
  return { kind: "spaces", width };
}
