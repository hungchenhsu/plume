// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { eolMarkPositions, indentGuideLevels, lineSpanForSelectionInDoc } from "./editor";
import { lineSpanForSelection } from "./lineops";

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
