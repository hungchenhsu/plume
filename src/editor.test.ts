// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { eolMarkPositions } from "./editor";

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
