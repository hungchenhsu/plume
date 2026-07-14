// See CLAUDE.md "Frontend logic that doesn't need the WebView" — pure
// string[]->IndentInfo classification, fully covered without CodeMirror or
// jsdom. The CM6-facing wrapper (`detectIndentationOf` in editor.ts, which
// samples a live buffer's lines via `Text.iterLines` and hands them to
// `detectIndentation` here) is covered separately in editor.test.ts, the
// same split as textstats.ts/`textStatsOf` and lineops.ts/`transformLines`.
import { describe, expect, it } from "vitest";
import { detectIndentation } from "./indentdetect";

describe("detectIndentation: none", () => {
  it("reports none for a single empty line (empty document)", () => {
    expect(detectIndentation([""])).toEqual({ kind: "none" });
  });

  it("reports none for no lines at all", () => {
    expect(detectIndentation([])).toEqual({ kind: "none" });
  });

  it("reports none when no line has any leading whitespace", () => {
    expect(detectIndentation(["function foo() {", "return 1;", "}"])).toEqual({
      kind: "none",
    });
  });

  it("reports none when every line is blank or whitespace-only", () => {
    expect(detectIndentation(["", "   ", "\t", ""])).toEqual({ kind: "none" });
  });
});

describe("detectIndentation: tabs", () => {
  it("reports tabs (no width) when every indented line leads with a tab", () => {
    expect(detectIndentation(["function foo() {", "\treturn 1;", "}"])).toEqual({
      kind: "tabs",
    });
  });

  it("reports tabs regardless of how many tab levels appear", () => {
    expect(
      detectIndentation(["a", "\tb", "\t\tc", "\tb2", "a2"]),
    ).toEqual({ kind: "tabs" });
  });
});

describe("detectIndentation: mixed", () => {
  it("reports mixed when a single line's leading run has spaces then a tab", () => {
    expect(detectIndentation(["a", "   \tb"])).toEqual({ kind: "mixed" });
  });

  it("reports mixed when a single line's leading run has a tab then spaces", () => {
    expect(detectIndentation(["a", "\t   b"])).toEqual({ kind: "mixed" });
  });

  it("reports mixed when different lines use tabs vs. spaces (not mixed within one line)", () => {
    expect(detectIndentation(["\tfoo", "    bar"])).toEqual({ kind: "mixed" });
  });

  it("reports mixed even when the mixed-within-line case is the only indented line", () => {
    expect(detectIndentation([" \tonly"])).toEqual({ kind: "mixed" });
  });
});

describe("detectIndentation: spaces (width via mode of adjacent depth diffs)", () => {
  it("detects width 4 from a single-level indent bracketed by depth-0 lines", () => {
    expect(
      detectIndentation(["function foo() {", "    return 1;", "}"]),
    ).toEqual({ kind: "spaces", width: 4 });
  });

  it("detects width 2", () => {
    expect(detectIndentation(["a", "  b", "a2"])).toEqual({ kind: "spaces", width: 2 });
  });

  it("detects width 8 when every step is consistently 8", () => {
    expect(detectIndentation(["a", "        b", "                c"])).toEqual({
      kind: "spaces",
      width: 8,
    });
  });

  it("picks the mode, not the first diff, when a deeper initial jump is outnumbered by consistent 4-space steps", () => {
    // Depths 0, 8, 12, 16 -> diffs 8, 4, 4. The lone 8 (e.g. a pasted,
    // already-nested block) must not win over the more frequent 4.
    expect(
      detectIndentation(["a", "        b", "            c", "                d"]),
    ).toEqual({ kind: "spaces", width: 4 });
  });

  it("breaks a tie between equally-frequent diffs by picking the smaller width", () => {
    // Depths 0, 2, 0, 4, 0 -> diffs 2, 2, 4, 4 (a tie between 2 and 4).
    expect(
      detectIndentation(["a", "  b", "c", "    d", "e"]),
    ).toEqual({ kind: "spaces", width: 2 });
  });

  it("falls back to the single observed depth when no diff is computable (one indented line, no baseline)", () => {
    expect(detectIndentation(["    foo"])).toEqual({ kind: "spaces", width: 4 });
  });

  it("falls back to the repeated depth when every indented line shares the same depth with no variation", () => {
    expect(detectIndentation(["    a", "    b", "    c"])).toEqual({
      kind: "spaces",
      width: 4,
    });
  });

  it("does not break the diff chain across a blank line", () => {
    expect(
      detectIndentation(["function foo() {", "", "    return 1;", "", "}"]),
    ).toEqual({ kind: "spaces", width: 4 });
  });

  it("ignores whitespace-only lines the same way as fully-empty ones for the diff chain", () => {
    expect(
      detectIndentation(["function foo() {", "   ", "    return 1;", "}"]),
    ).toEqual({ kind: "spaces", width: 4 });
  });
});
