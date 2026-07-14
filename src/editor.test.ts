// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { describe, expect, it } from "vitest";
import {
  eolMarkPositions,
  indentGuideLevels,
  lineSpanForSelectionInDoc,
  textStatsOf,
} from "./editor";
import { lineSpanForSelection } from "./lineops";
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
