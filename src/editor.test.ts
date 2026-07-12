// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { eolMarkPositions, indentGuideLevels } from "./editor";

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
