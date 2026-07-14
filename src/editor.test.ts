// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { moveLineDown as cmMoveLineDown } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView, highlightSpecialChars } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { describe, expect, it, vi } from "vitest";
import {
  characterBeforeCursor,
  detectIndentationOf,
  eolMarkPositions,
  INDENT_DETECTION_SAMPLE_LINES,
  indentGuideLevels,
  isNonNfcOf,
  lineSpanForSelectionInDoc,
  suspiciousCharCountOf,
  textStatsOf,
} from "./editor";
import { detectIndentation } from "./indentdetect";
import { lineSpanForSelection } from "./lineops";
import { scanSuspiciousChars, SUSPICIOUS_CHARS_PATTERN } from "./suspiciouschars";
import { countTextStats } from "./textstats";

describe("eolMarkPositions", () => {
  it("returns no positions for an empty document", () => {
    const doc = Text.of([""]);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([]);
  });

  it("returns no positions for a single line with no trailing newline", () => {
    const doc = Text.of(["abc"]);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([]);
  });

  it("marks every line end except the last when the file has no trailing newline", () => {
    // "a\nb\nc" -> lines ["a", "b", "c"], no trailing newline.
    const doc = Text.of(["a", "b", "c"]);
    expect(doc.lines).toBe(3);
    // Line 1 ends at offset 1 ("a"), line 2 ends at offset 3 ("a\nb"); line
    // 3 ("c") is the last line and has no trailing newline, so it's unmarked.
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([1, 3]);
  });

  it("marks the second-to-last line too when the file ends with a trailing newline", () => {
    // "a\nb\n" -> CM6 represents this as lines ["a", "b", ""]: the trailing
    // newline produces an empty final line, which itself has no newline
    // after it and so is correctly left unmarked.
    const doc = Text.of(["a", "b", ""]);
    expect(doc.lines).toBe(3);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([1, 3]);
  });

  it("restricts marks to the given [from, to] range (visible-range perf path)", () => {
    const doc = Text.of(["a", "b", "c", "d"]);
    // Only ask about the middle of the document (covering lines 2-3).
    const from = doc.line(2).from;
    const to = doc.line(3).to;
    expect(eolMarkPositions(doc, from, to)).toEqual([doc.line(2).to, doc.line(3).to]);
  });
});

// Pure logic behind indent-guide vertical lines (ROADMAP.md Track C /
// issue #74). Like eolMarkPositions above, this is the reachable-without-a-
// live-EditorView slice of editor.ts's indent-guide feature — the
// ViewPlugin that turns this into decorations needs a real layout engine
// and is exercised manually instead (see CLAUDE.md "Frontend logic that
// doesn't need the WebView").
describe("indentGuideLevels", () => {
  it("returns 0 for an empty line", () => {
    expect(indentGuideLevels("", 4)).toBe(0);
  });

  it("returns 0 for an all-whitespace (blank) line of spaces, even if it would otherwise span a full level", () => {
    // Design decision: blank lines never get a guide in this first
    // version (no context-extension through them) — see the doc comment
    // on indentGuideLevels in editor.ts.
    expect(indentGuideLevels("        ", 4)).toBe(0);
  });

  it("returns 0 for an all-whitespace (blank) line of tabs", () => {
    expect(indentGuideLevels("\t\t", 4)).toBe(0);
  });

  it("returns 0 when the line has no leading whitespace", () => {
    expect(indentGuideLevels("foo", 4)).toBe(0);
  });

  it("returns 0 when leading spaces are fewer than one tabSize (not a full level)", () => {
    expect(indentGuideLevels("  foo", 4)).toBe(0);
  });

  it("returns 1 for exactly one tabSize of leading spaces", () => {
    expect(indentGuideLevels("    foo", 4)).toBe(1);
  });

  it("returns 2 for exactly two tabSizes of leading spaces", () => {
    expect(indentGuideLevels("        foo", 4)).toBe(2);
  });

  it("floors a partial extra column beyond a full level, rather than rounding up", () => {
    // 5 leading spaces at tabSize 4 is one full level plus one leftover
    // column, which isn't enough for a second guide.
    expect(indentGuideLevels("     foo", 4)).toBe(1);
  });

  it("counts a single leading tab as exactly one level, regardless of tabSize", () => {
    expect(indentGuideLevels("\tfoo", 4)).toBe(1);
    expect(indentGuideLevels("\tfoo", 2)).toBe(1);
  });

  it("counts multiple leading tabs as that many levels", () => {
    expect(indentGuideLevels("\t\tfoo", 4)).toBe(2);
  });

  it("expands a tab to the next tab stop, not a fixed width, when mixed with spaces", () => {
    // 3 spaces then a tab then 3 more spaces, tabSize 4: the tab only
    // needs to advance one column (3 -> 4) to reach the next stop, so the
    // leading whitespace is 7 columns wide (floor(7/4) = 1 level) — not
    // 10, which is what you'd get by naively treating every tab as a
    // fixed +tabSize regardless of the column it starts at (that wrong
    // algorithm would floor(10/4) to 2 levels instead).
    expect(indentGuideLevels("   \t   x", 4)).toBe(1);
  });

  it("changes level count with tabSize for the same text", () => {
    expect(indentGuideLevels("        foo", 2)).toBe(4);
    expect(indentGuideLevels("        foo", 4)).toBe(2);
  });

  it("ignores whitespace that isn't leading (interior/trailing content is irrelevant)", () => {
    expect(indentGuideLevels("    foo   ", 4)).toBe(1);
  });
});

/**
 * Builds the CM6 `Text` a live buffer would have for `text`, the same way
 * `EditorState.create({ doc: text })` does internally: split on "\n", hand
 * the line array to `Text.of`. Local to this file's oracle-equivalence
 * checks below, which need a `Text` for `lineSpanForSelectionInDoc` and the
 * plain string it was built from for `lineSpanForSelection` (lineops.ts) —
 * both from the exact same document.
 */
function toDoc(text: string): Text {
  return Text.of(text.split("\n"));
}

// Oracle-equivalence coverage for issue #107: `EditorHandle.transformLines`
// used to call lineops.ts's `lineSpanForSelection` (a pure string function)
// against `state.doc.toString()`, materializing the whole document just to
// compute two offsets. `lineSpanForSelectionInDoc` (editor.ts) answers the
// same question straight from `state.doc` via `Text.lineAt`, with no
// materialization — but "no materialization" is only a safe change if it
// produces identical `{ from, to }` results to the string version it
// replaces, for every case that version handles, including the issue #99 /
// PR #106 to-1 regression it was built to fix. `lineSpanForSelection`
// itself is kept around (not deleted) specifically to serve as that
// reference oracle here, rather than being inlined away now that
// `transformLines` no longer calls it — see both functions' doc comments.
describe("lineSpanForSelectionInDoc (oracle: must match lineops.ts's lineSpanForSelection)", () => {
  it("agrees on issue #99: selection's exclusive end at column 1 of the next line stops before that line", () => {
    // "b\na\nc": selecting [0, 2) highlights "b" plus its newline, ending
    // exactly at the start of line 2 ("a") — the core regression case.
    const text = "b\na\nc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees when a selection ends mid-line: expands to that line's full extent", () => {
    const text = "bbb\naaa";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees on a multi-line selection ending mid-line on a later line", () => {
    // to - 1 (6) is inside line 3 ("cc"), so the span covers all three
    // lines, through the end of the document.
    const text = "aa\nbb\ncc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 7)).toEqual(lineSpanForSelection(text, 0, 7));
  });

  it("agrees on a multi-line selection whose exclusive end lands at a later line's start, stopping one line short", () => {
    // Same text; to === 6 is column 1 of line 3, so the span covers only
    // lines 1-2 — the multi-line generalization of the issue #99 case.
    const text = "aa\nbb\ncc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees on the last line when the document has no trailing newline", () => {
    const text = "a\nb";
    expect(lineSpanForSelectionInDoc(toDoc(text), 2, 3)).toEqual(lineSpanForSelection(text, 2, 3));
  });

  it("agrees that a following empty line is excluded the same way a following non-empty one is", () => {
    const text = "a\n\nb";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees that a selection inside a leading empty line does not spill into line 2", () => {
    const text = "\nfoo";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 1)).toEqual(lineSpanForSelection(text, 0, 1));
  });

  it("agrees on a single-line file with no newline at all: the span is the whole document", () => {
    const text = "only";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 4)).toEqual(lineSpanForSelection(text, 0, 4));
  });

  it("agrees on a whole-file selection spanning every line of a multi-line document", () => {
    const text = "xx\nyyy";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees on a whole-file selection when the document ends with a trailing newline", () => {
    const text = "a\nb\nc\n";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees that reaching exactly the end of a document with a trailing newline does not pull in the trailing empty line", () => {
    // "a\nb\n" is lines ["a", "b", ""]; selecting [2, 4) is "b" plus its
    // own trailing newline, ending exactly at doc.length. to - 1 (3) is
    // the offset of that final "\n" itself, which both implementations
    // must resolve to line 2 ("b"), not the empty line 3 after it.
    const text = "a\nb\n";
    expect(lineSpanForSelectionInDoc(toDoc(text), 2, 4)).toEqual(lineSpanForSelection(text, 2, 4));
  });

  it("agrees that both throw for an empty selection (cursor), at the start, middle, and end of the document", () => {
    // transformLines never calls either function for an empty selection
    // (a cursor gets the whole document instead — see editor.ts), but the
    // two must still fail the same way if ever misused, per both
    // functions' doc comments.
    const text = "aa\nbb\ncc";
    const doc = toDoc(text);
    for (const pos of [0, 4, text.length]) {
      expect(() => lineSpanForSelectionInDoc(doc, pos, pos)).toThrow();
      expect(() => lineSpanForSelection(text, pos, pos)).toThrow();
    }
  });
});

// ROADMAP.md Track C multi-cursor: unlike everything above, this needs no
// live EditorView — `EditorState.create`/`state.update` are pure and need
// no layout engine, so the actual mechanism Mod-d (`selectNextOccurrence`)
// and Mod-Shift-l (`selectSelectionMatches`, both @codemirror/search,
// already in basicSetup's searchKeymap) rely on is directly testable: a
// transaction's selection only keeps more than one range when
// `EditorState.allowMultipleSelections` is on, per @codemirror/state's
// own `EditorState.applyTransaction` (`tr.newSelection` vs
// `tr.newSelection.asSingle()`). `createEditor`'s extensions always start
// with `basicSetup` (see editor.ts), which is what actually turns this on
// for the app — verified from source, not assumed (basicSetup's own
// module includes `EditorState.allowMultipleSelections.of(true)`).
describe("allowMultipleSelections (ROADMAP.md Track C multi-cursor)", () => {
  // Two ranges a command like selectNextOccurrence would dispatch after
  // matching a second "abc" in "abc abc abc".
  const twoRanges = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]);

  it("collapses a multi-range selection to just the main range when the extension is absent", () => {
    // Baseline with no extensions at all: this is what would silently
    // defeat Mod-d/Mod-Shift-l if createEditor's extensions ever stopped
    // including basicSetup (or some other source of this facet).
    const state = EditorState.create({ doc: "abc abc abc" });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(1);
  });

  it("keeps every range once allowMultipleSelections is on", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(2);
  });

  it("is already on via basicSetup, the extension bundle createEditor always includes", () => {
    const state = EditorState.create({ doc: "abc abc abc", extensions: [basicSetup] });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(2);
  });
});

// ROADMAP.md v0.4 Track C per-tab read-only mode. editor.ts's setReadOnly
// (see createEditor) reconfigures a dedicated Compartment between `[]` and
// `[EditorState.readOnly.of(true), EditorView.editable.of(false)]` — the
// exact same extension pair newBuffer already applies fixed at construction
// for a truncated large-file preview. This suite doesn't exercise setReadOnly
// itself (that needs a live EditorView + DOM parent, which this file's other
// suites also avoid — see the module header), but pins the CM6-level
// assumption the whole design leans on: a plain Compartment reconfigure is
// enough to flip `state.readOnly`, and CM6's own line-operation commands
// (moveLineUp/moveLineDown/copyLineDown/deleteLine — every one of them
// reachable outside the Edit menu's own runLineOperation guard via
// basicSetup's default keymap, see editor.ts's moveLineUp doc comment) look
// at `state.readOnly` themselves and no-op without ever calling dispatch —
// verified from source (@codemirror/commands `moveLine`), not assumed.
describe("read-only via Compartment reconfigure (ROADMAP.md v0.4 Track C)", () => {
  const READ_ONLY_ON = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

  it("state.readOnly is true once the compartment holds the read-only extensions", () => {
    const readOnly = new Compartment();
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    expect(state.readOnly).toBe(true);
  });

  it("a CM6 command (moveLineDown) self-no-ops and never dispatches once read-only", () => {
    const readOnly = new Compartment();
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    const dispatch = vi.fn();
    const ran = cmMoveLineDown({ state, dispatch });
    expect(ran).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the same command runs normally once the compartment reconfigures back to empty", () => {
    const readOnly = new Compartment();
    const lockedState = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    const lifted = lockedState.update({ effects: readOnly.reconfigure([]) }).state;
    expect(lifted.readOnly).toBe(false);
    const dispatch = vi.fn();
    const ran = cmMoveLineDown({ state: lifted, dispatch });
    expect(ran).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// ROADMAP.md v0.4 Track C word/char/line count status-bar segment. Unlike
// eolMarkPositions/indentGuideLevels above (pure functions over a Text or
// plain string), textStatsOf reads a full EditorBuffer (EditorState),
// including its selection — but EditorState.create needs no live view or
// layout engine either, so this is fully reachable here without a WebView.
describe("textStatsOf", () => {
  it("reports whole-document stats when the selection is a single empty cursor", () => {
    const state = EditorState.create({ doc: "hello world\nsecond line" });
    const result = textStatsOf(state);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual(countTextStats("hello world\nsecond line"));
  });

  it("agrees with countTextStats for CJK-mixed whole-document content", () => {
    const text = "Hello 你好世界\nこんにちは안녕\nlast line";
    const state = EditorState.create({ doc: text });
    expect(textStatsOf(state).stats).toEqual(countTextStats(text));
  });

  it("reports selection stats (not whole-document) for a single non-empty range", () => {
    const state = EditorState.create({ doc: "hello world" });
    const withSelection = state.update({
      selection: EditorSelection.single(0, 5), // "hello"
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    expect(result.stats).toEqual({ chars: 5, words: 1, lines: 1 });
  });

  it("sums stats across every non-empty range for a multi-cursor selection", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    // Select the first and third "abc" (3 chars, 1 word each).
    const withSelection = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 11),
      ]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    // "lines" sums per-range too, per spec ("多選取時加總所有 ranges") — each
    // range independently spans 1 line here, even though both ranges sit
    // on the *same* physical line of a single-line document, so the total
    // is 2, not the 1 distinct line actually touched. Deliberate: see
    // textStatsOf's doc comment in editor.ts.
    expect(result.stats).toEqual({ chars: 6, words: 2, lines: 2 });
  });

  it("ignores empty ranges mixed in with a non-empty one (multi-cursor, only one range has a selection)", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const withSelection = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3), // "abc" selected
        EditorSelection.cursor(8), // bare cursor, no selection
      ]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    expect(result.stats).toEqual({ chars: 3, words: 1, lines: 1 });
  });

  it("treats every range being empty (multiple bare cursors) as no selection", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const withSelection = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(8)]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual(countTextStats("abc abc abc"));
  });

  it("does not count a selection's own trailing newline as spanning a further line", () => {
    // "AAA\nBBB": selecting through "AAA\n" only (issue #99-style boundary).
    const state = EditorState.create({ doc: "AAA\nBBB" });
    const withSelection = state.update({ selection: EditorSelection.single(0, 4) }).state;
    const result = textStatsOf(withSelection);
    expect(result.stats).toEqual({ chars: 4, words: 1, lines: 1 });
  });

  it("handles an empty document (0 chars, 0 words, 1 line)", () => {
    const state = EditorState.create({ doc: "" });
    const result = textStatsOf(state);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual({ chars: 0, words: 0, lines: 1 });
  });

  it("walks a document large enough to span many internal Text leaves/nodes", () => {
    // TextLeaf caps at 32 lines per node (@codemirror/state's own
    // Tree.Branch) before TextNode.from/TextLeaf.split kicks in — a
    // 200-line document forces textStatsOf's Text.iterRange walk across
    // multiple internal chunks, not just one small leaf.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} 你好`);
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    expect(textStatsOf(state).stats).toEqual(countTextStats(text));
  });

  it("computes selection stats correctly across a many-leaf document (mid-tree range)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} 你好`);
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    // Select from partway into line 50 through partway into line 150.
    const from = state.doc.line(50).from + 2;
    const to = state.doc.line(150).from + 2;
    const withSelection = state.update({ selection: EditorSelection.single(from, to) }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    // Oracle: the number of lines a selection touches is lineAt(to-1) minus
    // lineAt(from) inclusive — the same to-1 convention
    // lineSpanForSelectionInDoc uses to resolve a selection's end line
    // (issue #99), which finishRangeTextStats is designed to match.
    expect(result.stats.lines).toBe(
      state.doc.lineAt(to - 1).number - state.doc.lineAt(from).number + 1,
    );
  });
});

// ROADMAP.md v0.4 Track A invisible/ambiguous character audit status-bar
// count. Like textStatsOf above, EditorState.create needs no live view or
// layout engine, so the Text.iterRange chunk-walk is fully reachable here.
describe("suspiciousCharCountOf", () => {
  it("is 0 for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(suspiciousCharCountOf(state)).toBe(0);
  });

  it("is 0 for ordinary text with no curated characters", () => {
    const state = EditorState.create({ doc: "hello world\n你好，世界" });
    expect(suspiciousCharCountOf(state)).toBe(0);
  });

  it("counts curated characters across categories in one small document", () => {
    // "a" + RLO (bidi) + "\n" + "b" + ZWSP (zeroWidth) + NBSP (whitespace)
    const text = `a${String.fromCharCode(0x202e)}\nb${String.fromCharCode(0x200b)}${String.fromCharCode(0x00a0)}`;
    const state = EditorState.create({ doc: text });
    expect(suspiciousCharCountOf(state)).toBe(3);
  });

  it("walks a document large enough to span many internal Text leaves/nodes", () => {
    // Same technique as textStatsOf's own many-leaf test above (TextLeaf
    // caps at 32 lines per node) — one curated character (alternating
    // category) on every 10th line, forcing the Text.iterRange walk across
    // multiple internal chunks and proving per-chunk counts sum correctly
    // rather than dropping or double-counting anything at a chunk boundary.
    const curated = [0x202e, 0x200b, 0x00a0]; // RLO, ZWSP, NBSP
    const lines = Array.from({ length: 200 }, (_, i) =>
      i % 10 === 0 ? `line ${i} ${String.fromCharCode(curated[i % curated.length])}` : `line ${i}`,
    );
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    // Oracle: scanSuspiciousChars's own whole-string scan (suspiciouschars.ts),
    // independent of the Text.iterRange chunking being exercised here —
    // mirrors textStatsOf's many-leaf test comparing against countTextStats.
    expect(suspiciousCharCountOf(state)).toBe(scanSuspiciousChars(text).length);
    expect(suspiciousCharCountOf(state)).toBe(20); // sanity: one per 10th line, 200/10
  });
});

// ROADMAP.md v0.4 Track A Unicode normalization [danger].
describe("isNonNfcOf", () => {
  it("is false for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(isNonNfcOf(state)).toBe(false);
  });

  it("is false for ordinary already-NFC text (ASCII and CJK)", () => {
    const state = EditorState.create({ doc: "hello world\n中文編碼偵測測試" });
    expect(isNonNfcOf(state)).toBe(false);
  });

  // NFD/NFC fixtures below spell "cafe" plus an accented "e" via
  // explicit \u escapes rather than a literal accented character in
  // source: a bare literal risks silently being whichever Unicode
  // normalization form it happens to get typed as, defeating the point
  // of pinning one specific form.
  const NFD_CAFE = "cafe" + "\u0301"; // "e" + combining acute accent (NFD)
  const NFC_CAFE = "cafe\u0301".normalize("NFC"); // precomposed U+00E9 (NFC)

  it("is true for a decomposed (NFD) combining sequence", () => {
    const state = EditorState.create({ doc: NFD_CAFE });
    expect(isNonNfcOf(state)).toBe(true);
  });

  it("is false once the same content is precomposed", () => {
    const state = EditorState.create({ doc: NFC_CAFE });
    expect(isNonNfcOf(state)).toBe(false);
  });

  /**
   * `isNonNfcOf` must still find a decomposed sequence correctly once the
   * document spans multiple internal `Text` leaves (`TextLeaf` caps at 32
   * lines per node — same technique `suspiciousCharCountOf`'s own many-leaf
   * test above uses), proving the chunk-by-chunk walk doesn't drop or
   * misjudge anything just because `Text.iter()` enumerates many chunks
   * rather than one. This does not (and — per `isNfcChunked`'s doc comment —
   * cannot) exercise a combining sequence actually split *across* a chunk
   * boundary: CM6's chunk boundaries are always real line breaks, and a
   * combining mark right after a "\n" never composes with the previous
   * line's last character (verified: `("e\n" + "́").normalize("NFC")`
   * is a no-op) — so placing the decomposed sequence on its own line, far
   * from line 1, is what actually exercises "found deep inside a multi-leaf
   * document", not a boundary split. The chunk-boundary-splitting hazard
   * itself is exercised directly on `isNfcChunked` with hand-built chunk
   * arrays in normalize.test.ts, where a chunk source that isn't
   * line-aligned is possible to construct at all.
   */
  it("still detects a decomposed sequence deep inside a document spanning many internal Text leaves", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[75] = NFD_CAFE; // "e" + combining acute, on a line past the first leaf
    const state = EditorState.create({ doc: lines.join("\n") });
    expect(isNonNfcOf(state)).toBe(true);
  });
});

// Pins the CM6-level assumption editor.ts's `suspiciousCharsExtension`
// leans on (see its doc comment in editor.ts): overlaying a curated
// `addSpecialChars` pattern alongside basicSetup's own bare
// `highlightSpecialChars()` must never hit @codemirror/state's
// `combineConfig` "Config merge conflict" error. Reconstructs the same
// overlay shape independently via publicly exported pieces (CM6's own
// `highlightSpecialChars` plus suspiciouschars.ts's exported pattern)
// rather than importing editor.ts's private `suspiciousCharsExtension`
// constant — same "verify the real CM6 mechanism, don't just trust a
// private implementation detail" approach as the read-only and
// allowMultipleSelections suites above, which need a live EditorView to
// go further than this (this file's header comment), so — like those —
// this only proves the state-level assumption, not the rendered pixels.
describe("suspicious-chars highlightSpecialChars overlay (ROADMAP.md v0.4 Track A)", () => {
  it("does not throw a facet merge conflict when layered alongside basicSetup's own highlightSpecialChars", () => {
    expect(() =>
      EditorState.create({
        doc: "hello",
        extensions: [basicSetup, highlightSpecialChars({ addSpecialChars: SUSPICIOUS_CHARS_PATTERN })],
      }),
    ).not.toThrow();
  });
});

// ROADMAP.md v0.4 Track A character inspector: the Unicode code point
// immediately before the cursor (Backspace-would-delete semantics — see
// characterBeforeCursor's doc comment in editor.ts for why a line start
// returns null instead of reaching across the previous line's newline).
// Like textStatsOf above, EditorState.create needs no live view.
describe("characterBeforeCursor", () => {
  it("returns null for an empty document (cursor at the only, empty line)", () => {
    const state = EditorState.create({ doc: "" });
    expect(characterBeforeCursor(state)).toBeNull();
  });

  it("returns null when the cursor sits at the very start of the document", () => {
    const state = EditorState.create({ doc: "abc" }); // default cursor is 0
    expect(characterBeforeCursor(state)).toBeNull();
  });

  it("returns null at the start of a later line, not the previous line's newline", () => {
    const state = EditorState.create({ doc: "abc\ndef" });
    const pos = state.doc.line(2).from; // start of "def"
    const withCursor = state.update({ selection: EditorSelection.cursor(pos) }).state;
    expect(characterBeforeCursor(withCursor)).toBeNull();
  });

  it("returns the single character immediately before the cursor, not the one after it", () => {
    const state = EditorState.create({ doc: "AB" });
    const withCursor = state.update({ selection: EditorSelection.cursor(1) }).state; // between A and B
    expect(characterBeforeCursor(withCursor)).toBe("A");
  });

  it("returns the last character before the cursor at the end of the document", () => {
    const state = EditorState.create({ doc: "AB" });
    const withCursor = state.update({ selection: EditorSelection.cursor(2) }).state;
    expect(characterBeforeCursor(withCursor)).toBe("B");
  });

  it("returns a CJK character (multi-byte in UTF-8, one UTF-16 unit) whole", () => {
    const state = EditorState.create({ doc: "中" });
    const withCursor = state.update({ selection: EditorSelection.cursor(1) }).state;
    expect(characterBeforeCursor(withCursor)).toBe("中");
  });

  it("assembles a surrogate pair into the one code point it represents, not half of it", () => {
    // U+1F600 GRINNING FACE is 2 UTF-16 code units in a JS string.
    const emoji = "\u{1F600}";
    const state = EditorState.create({ doc: `x${emoji}` });
    expect(state.doc.length).toBe(3); // "x" + 2 surrogate code units
    const withCursor = state.update({ selection: EditorSelection.cursor(3) }).state;
    const result = characterBeforeCursor(withCursor);
    expect(result).toBe(emoji);
    expect(result?.codePointAt(0)).toBe(0x1f600);
  });

  it("does not pull a surrogate pair's high half across a line start", () => {
    // A supplementary character can never actually straddle a line break,
    // but this pins that the line-start short-circuit still fires even
    // when the immediately preceding line ends in one, rather than the
    // 2-code-unit lookback window accidentally reaching across the
    // boundary into the previous line's content.
    const emoji = "\u{1F600}";
    const state = EditorState.create({ doc: `${emoji}\ny` });
    const pos = state.doc.line(2).from;
    const withCursor = state.update({ selection: EditorSelection.cursor(pos) }).state;
    expect(characterBeforeCursor(withCursor)).toBeNull();
  });
});

// ROADMAP.md v0.4 Track C indentation tools: the CM6-facing sampling
// wrapper around indentdetect.ts's pure `detectIndentation`. Like
// textStatsOf/suspiciousCharCountOf above, EditorState.create needs no live
// view, so the `Text.iterLines` sampling walk is fully reachable here. The
// classification heuristic itself (mode of adjacent depth diffs, tabs vs.
// spaces vs. mixed vs. none) is exhaustively covered in indentdetect.test.ts
// against plain string arrays — this suite only proves the wrapper samples
// a live buffer's lines correctly and agrees with that oracle, plus the
// sample-limit boundary itself.
describe("detectIndentationOf", () => {
  it("agrees with detectIndentation for ordinary space-indented content", () => {
    const text = "function foo() {\n    return 1;\n}";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state)).toEqual(detectIndentation(text.split("\n")));
    expect(detectIndentationOf(state)).toEqual({ kind: "spaces", width: 4 });
  });

  it("agrees with detectIndentation for tab-indented content", () => {
    const text = "function foo() {\n\treturn 1;\n}";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state)).toEqual({ kind: "tabs" });
  });

  it("reports none for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(detectIndentationOf(state)).toEqual({ kind: "none" });
  });

  it("honors an explicit sampleLimit smaller than the document, ignoring later lines entirely", () => {
    // First 2 lines are consistently 2-space indented; a later tab-indented
    // line would flip the result to "mixed" if it were ever sampled —
    // passing sampleLimit=2 must exclude it.
    const text = "a\n  b\na2\n\tc";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state, 2)).toEqual({ kind: "spaces", width: 2 });
    // Sanity: without the limit (or a large enough one), the later line
    // does change the answer, proving the limit is actually doing something.
    expect(detectIndentationOf(state, 4)).toEqual({ kind: "mixed" });
    expect(detectIndentation(text.split("\n"))).toEqual({ kind: "mixed" });
  });

  it("defaults to sampling only the first 1000 lines of a much larger document", () => {
    // Lines 1-1000: consistent 2-space indentation (a clean "spaces" file).
    // Lines 1001+: tab-indented instead. If the default sample window were
    // larger than 1000 (or unbounded), those later tab-indented lines would
    // flip the result to "mixed" (spaces and tabs both present) — the
    // default must stop exactly at 1000 and never see them.
    const head = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? "a" : "  b"));
    const tail = Array.from({ length: 50 }, () => "\tc");
    const text = [...head, ...tail].join("\n");
    const state = EditorState.create({ doc: text });
    expect(state.doc.lines).toBe(1050);
    expect(INDENT_DETECTION_SAMPLE_LINES).toBe(1000);
    expect(detectIndentationOf(state)).toEqual({ kind: "spaces", width: 2 });
    // Sanity: a large-enough explicit sample does see the tab-indented
    // tail and correctly flips to "mixed", proving the boundary is real
    // and not just a coincidental match.
    expect(detectIndentationOf(state, 1050)).toEqual({ kind: "mixed" });
  });

  it("uses the whole document when it has fewer lines than the sample limit", () => {
    const text = "a\n  b\nc";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state, 1000)).toEqual(detectIndentationOf(state, 3));
  });
});
