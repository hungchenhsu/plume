// See CLAUDE.md "Frontend logic that doesn't need the WebView" — these are
// plain string->string functions, fully covered without CodeMirror or
// jsdom. The view-layer callers (`EditorHandle.transformLines` /
// `transformSelection` in editor.ts) dispatch into a live CM6 EditorView
// and are not covered here for the same reason editor.test.ts only covers
// `eolMarkPositions`: jsdom has no real layout engine for CM6 to run
// against.
import { describe, expect, it } from "vitest";
import {
  convertLeadingSpacesToTabs,
  convertLeadingTabsToSpaces,
  lineSpanForSelection,
  lowerCase,
  sortLines,
  trimTrailingWhitespace,
  uniqueLines,
  upperCase,
} from "./lineops";

describe("sortLines", () => {
  it("sorts lines ascending by code point", () => {
    expect(sortLines("banana\napple\ncherry")).toBe("apple\nbanana\ncherry");
  });

  it("preserves a trailing newline when the input has one", () => {
    expect(sortLines("b\na\n")).toBe("a\nb\n");
  });

  it("does not introduce a trailing newline when the input has none", () => {
    expect(sortLines("b\na")).toBe("a\nb");
  });

  it("returns an empty string for an empty string", () => {
    expect(sortLines("")).toBe("");
  });

  it("leaves a single line with no newline unchanged", () => {
    expect(sortLines("only")).toBe("only");
  });

  it("keeps every duplicate line (sorting is not deduping) and groups them together", () => {
    // Stability itself (order preserved among lines that compare equal) is
    // unobservable from the outside when the sort key is the whole line:
    // two lines only ever compare equal by being character-for-character
    // identical, so no output could tell a stable sort from an unstable
    // one here. What IS observable, and is what a correct stable sort
    // guarantees, is that no duplicate is dropped or merged.
    const input = "b\na\nb\nc\na";
    expect(sortLines(input)).toBe("a\na\nb\nb\nc");
  });

  it("sorts by true Unicode code point, not by UTF-16 code unit", () => {
    // U+1F600 (a supplementary-plane emoji) encodes as the surrogate pair
    // 😀, whose lead unit (0xD83D = 55357) is numerically less
    // than � (0xFFFD = 65533). Naive UTF-16-code-unit comparison
    // (plain `<`, or Array.sort() with no comparator) would therefore sort
    // the emoji BEFORE �. The true code points are U+1F600 (128512)
    // and U+FFFD (65533), so correct code-point order is the opposite:
    // � sorts first.
    const emoji = "😀";
    const replacementChar = "�";
    expect(emoji < replacementChar).toBe(true); // sanity check: naive order is backwards
    expect(sortLines(`${emoji}\n${replacementChar}`)).toBe(`${replacementChar}\n${emoji}`);
  });

  it("does not depend on locale-sensitive collation", () => {
    // localeCompare would sort these case-insensitively / dictionary-style
    // on many locales; code-point order sorts all uppercase ASCII before
    // all lowercase ASCII (uppercase letters are U+0041-U+005A, lowercase
    // are U+0061-U+007A).
    expect(sortLines("banana\nApple")).toBe("Apple\nbanana");
  });
});

describe("uniqueLines", () => {
  it("removes non-adjacent duplicates, keeping first-occurrence order", () => {
    expect(uniqueLines("a\nb\na\nc\nb")).toBe("a\nb\nc");
  });

  it("removes adjacent duplicates too", () => {
    expect(uniqueLines("a\na\na\nb")).toBe("a\nb");
  });

  it("leaves already-unique input unchanged", () => {
    expect(uniqueLines("a\nb\nc")).toBe("a\nb\nc");
  });

  it("preserves a trailing newline when the input has one", () => {
    expect(uniqueLines("a\na\n")).toBe("a\n");
  });

  it("does not introduce a trailing newline when the input has none", () => {
    expect(uniqueLines("a\na")).toBe("a");
  });

  it("returns an empty string for an empty string", () => {
    expect(uniqueLines("")).toBe("");
  });

  it("leaves a single line with no newline unchanged", () => {
    expect(uniqueLines("only")).toBe("only");
  });

  it("treats empty lines like any other line value for deduping", () => {
    expect(uniqueLines("a\n\nb\n\nc")).toBe("a\n\nb\nc");
  });
});

describe("trimTrailingWhitespace", () => {
  it("removes trailing spaces from every line", () => {
    expect(trimTrailingWhitespace("foo   \nbar")).toBe("foo\nbar");
  });

  it("removes trailing tabs from every line", () => {
    expect(trimTrailingWhitespace("foo\t\t\nbar")).toBe("foo\nbar");
  });

  it("removes mixed trailing spaces and tabs", () => {
    expect(trimTrailingWhitespace("foo \t \nbar")).toBe("foo\nbar");
  });

  it("does not touch leading or interior whitespace", () => {
    expect(trimTrailingWhitespace("  foo  bar  \n  baz")).toBe("  foo  bar\n  baz");
  });

  it("does not touch a trailing carriage return (buffer is LF-normalized; defensive only)", () => {
    // "foo\r\nbar" splits on "\n" into ["foo\r", "bar"]: \r is line 1's
    // last character, but it is neither space nor tab, so the trim regex
    // must leave it alone.
    expect(trimTrailingWhitespace("foo\r\nbar")).toBe("foo\r\nbar");
  });

  it("preserves a trailing newline when the input has one", () => {
    expect(trimTrailingWhitespace("foo  \n")).toBe("foo\n");
  });

  it("does not introduce a trailing newline when the input has none", () => {
    expect(trimTrailingWhitespace("foo  ")).toBe("foo");
  });

  it("returns an empty string for an empty string", () => {
    expect(trimTrailingWhitespace("")).toBe("");
  });

  it("leaves a single line with no newline and no trailing whitespace unchanged", () => {
    expect(trimTrailingWhitespace("only")).toBe("only");
  });

  it("reduces a whitespace-only line to empty", () => {
    expect(trimTrailingWhitespace("a\n   \nb")).toBe("a\n\nb");
  });
});

describe("upperCase", () => {
  it("upper-cases ASCII text", () => {
    expect(upperCase("Hello, World!")).toBe("HELLO, WORLD!");
  });

  it("upper-cases across multiple lines", () => {
    expect(upperCase("foo\nbar")).toBe("FOO\nBAR");
  });

  it("returns an empty string for an empty string", () => {
    expect(upperCase("")).toBe("");
  });

  it("accepts JS's native Unicode case-mapping expansions as-is (German ß -> SS)", () => {
    expect(upperCase("straße")).toBe("STRASSE");
  });
});

describe("lowerCase", () => {
  it("lower-cases ASCII text", () => {
    expect(lowerCase("Hello, World!")).toBe("hello, world!");
  });

  it("lower-cases across multiple lines", () => {
    expect(lowerCase("FOO\nBAR")).toBe("foo\nbar");
  });

  it("returns an empty string for an empty string", () => {
    expect(lowerCase("")).toBe("");
  });

  it("round-trips with upperCase for plain ASCII", () => {
    expect(lowerCase(upperCase("MixedCase"))).toBe("mixedcase");
  });
});

// ROADMAP.md v0.4 Track C indentation tools: Edit > Line Operations'
// "Convert Leading Tabs to Spaces" / "Convert Leading Spaces to Tabs".
// Both only ever touch a line's *leading* whitespace run (the indentation),
// stopping at the first non-whitespace character — interior and trailing
// whitespace/content are untouched, same contract as trimTrailingWhitespace
// only touching trailing whitespace above. Tabs expand to the *next*
// tab-stop column, not a flat "one tab = width spaces" substitution — same
// convention as editor.ts's `indentGuideLevels` (a tab's width depends on
// the column it starts at, not a fixed count) — so a leading run mixing
// tabs and spaces converts correctly either direction.
describe("convertLeadingTabsToSpaces", () => {
  it("returns an empty string for an empty string", () => {
    expect(convertLeadingTabsToSpaces("", 4)).toBe("");
  });

  it("leaves a line with no leading whitespace unchanged", () => {
    expect(convertLeadingTabsToSpaces("foo", 4)).toBe("foo");
  });

  it("converts a single leading tab to `width` spaces", () => {
    expect(convertLeadingTabsToSpaces("\tfoo", 4)).toBe("    foo");
  });

  it("converts multiple leading tabs to that many groups of `width` spaces", () => {
    expect(convertLeadingTabsToSpaces("\t\tfoo", 4)).toBe("        foo");
  });

  it("uses the given width, not a hardcoded 4", () => {
    expect(convertLeadingTabsToSpaces("\tfoo", 2)).toBe("  foo");
  });

  it("leaves already-space-indented leading whitespace unchanged", () => {
    expect(convertLeadingTabsToSpaces("    foo", 4)).toBe("    foo");
  });

  it("expands a tab mixed with leading spaces to the next tab stop, not a flat width", () => {
    // 3 spaces then a tab, width 4: the tab only needs 1 more column to
    // reach the next stop (column 4), not a flat 4 more (which would give
    // 7 spaces total instead of the correct 4).
    expect(convertLeadingTabsToSpaces("   \tfoo", 4)).toBe("    foo");
  });

  it("does not touch interior or trailing whitespace, only the leading run", () => {
    expect(convertLeadingTabsToSpaces("\tfoo\tbar  ", 4)).toBe("    foo\tbar  ");
  });

  it("converts every line independently", () => {
    expect(convertLeadingTabsToSpaces("\ta\n\t\tb\nc", 4)).toBe("    a\n        b\nc");
  });

  it("preserves a trailing newline when the input has one", () => {
    expect(convertLeadingTabsToSpaces("\tfoo\n", 4)).toBe("    foo\n");
  });

  it("does not introduce a trailing newline when the input has none", () => {
    expect(convertLeadingTabsToSpaces("\tfoo", 4)).toBe("    foo");
  });

  it("converts a whitespace-only (blank) line's tabs to spaces like any other leading run", () => {
    expect(convertLeadingTabsToSpaces("\t\t", 4)).toBe("        ");
  });

  it("clamps a non-positive width to 1 instead of dividing by zero or throwing", () => {
    expect(convertLeadingTabsToSpaces("\tfoo", 0)).toBe(" foo");
    expect(convertLeadingTabsToSpaces("\tfoo", -4)).toBe(" foo");
  });
});

describe("convertLeadingSpacesToTabs", () => {
  it("returns an empty string for an empty string", () => {
    expect(convertLeadingSpacesToTabs("", 4)).toBe("");
  });

  it("leaves a line with no leading whitespace unchanged", () => {
    expect(convertLeadingSpacesToTabs("foo", 4)).toBe("foo");
  });

  it("converts exactly `width` leading spaces to one tab", () => {
    expect(convertLeadingSpacesToTabs("    foo", 4)).toBe("\tfoo");
  });

  it("converts multiple full groups of `width` spaces to that many tabs", () => {
    expect(convertLeadingSpacesToTabs("        foo", 4)).toBe("\t\tfoo");
  });

  it("groups by integer division of width and keeps the remainder as spaces", () => {
    // 5 leading spaces, width 4: one full group (-> one tab) plus a
    // 1-space remainder that isn't a full group, kept as a literal space.
    expect(convertLeadingSpacesToTabs("     foo", 4)).toBe("\t foo");
  });

  it("keeps a sub-width run of spaces as spaces (no full group at all)", () => {
    expect(convertLeadingSpacesToTabs("   foo", 4)).toBe("   foo");
  });

  it("uses the given width, not a hardcoded 4", () => {
    expect(convertLeadingSpacesToTabs("  foo", 2)).toBe("\tfoo");
  });

  it("leaves already-tab-indented leading whitespace unchanged", () => {
    expect(convertLeadingSpacesToTabs("\tfoo", 4)).toBe("\tfoo");
  });

  it("does not touch interior or trailing whitespace, only the leading run", () => {
    expect(convertLeadingSpacesToTabs("    foo  bar  ", 4)).toBe("\tfoo  bar  ");
  });

  it("converts every line independently", () => {
    expect(convertLeadingSpacesToTabs("    a\n        b\nc", 4)).toBe("\ta\n\t\tb\nc");
  });

  it("preserves a trailing newline when the input has one", () => {
    expect(convertLeadingSpacesToTabs("    foo\n", 4)).toBe("\tfoo\n");
  });

  it("does not introduce a trailing newline when the input has none", () => {
    expect(convertLeadingSpacesToTabs("    foo", 4)).toBe("\tfoo");
  });

  it("clamps a non-positive width to 1 instead of dividing by zero or throwing", () => {
    expect(convertLeadingSpacesToTabs("  foo", 0)).toBe("\t\tfoo");
    expect(convertLeadingSpacesToTabs("  foo", -4)).toBe("\t\tfoo");
  });
});

describe("convertLeadingTabsToSpaces / convertLeadingSpacesToTabs round-trip", () => {
  it("round-trips a pure-tabs document through spaces and back", () => {
    const text = "\ta\n\t\tb\nc";
    expect(convertLeadingSpacesToTabs(convertLeadingTabsToSpaces(text, 4), 4)).toBe(text);
  });

  it("round-trips a pure-spaces document (exact multiples of width) through tabs and back", () => {
    const text = "    a\n        b\nc";
    expect(convertLeadingTabsToSpaces(convertLeadingSpacesToTabs(text, 4), 4)).toBe(text);
  });

  it("round-trips spaces-with-remainder through tabs and back (remainder preserved)", () => {
    const text = "     a"; // 5 spaces: one full group plus a 1-space remainder
    expect(convertLeadingTabsToSpaces(convertLeadingSpacesToTabs(text, 4), 4)).toBe(text);
  });

  it("round-trips mixed leading whitespace (spaces then a tab) through the tabs conversion and back", () => {
    const text = "   \tfoo"; // column 4 total, width 4
    const asSpaces = convertLeadingTabsToSpaces(text, 4);
    expect(asSpaces).toBe("    foo");
    expect(convertLeadingSpacesToTabs(asSpaces, 4)).toBe("\tfoo");
  });
});

describe("lineSpanForSelection", () => {
  // Regression coverage for issue #99: EditorHandle.transformLines used to
  // resolve the span's end line from the selection's raw (exclusive) `to`,
  // so a selection that ended exactly at column 1 of the next line (i.e.
  // right after some line's newline) pulled that whole next line into the
  // span even though the user never selected any of it.
  it("stops the span at the end of the selection's last line, not the next line, when the selection's exclusive end lands at column 1 of the next line (issue #99)", () => {
    // "b\na\nc": selecting [0, 2) highlights "b" plus its newline, ending
    // exactly at the start of line 2 ("a"). to === 2 is column 1 of line
    // 2, but the user never selected any of line 2's text.
    expect(lineSpanForSelection("b\na\nc", 0, 2)).toEqual({ from: 0, to: 1 });
  });

  it("expands a selection that ends mid-line to that line's full extent", () => {
    // "bbb\naaa": selecting [0, 2) is just "bb", inside line 1 ("bbb").
    expect(lineSpanForSelection("bbb\naaa", 0, 2)).toEqual({ from: 0, to: 3 });
  });

  it("spans multiple lines when the selection ends mid-line on a later line", () => {
    // "aa\nbb\ncc": to - 1 (6) is inside line 3 ("cc"), so the span covers
    // all three lines, through the end of the document.
    expect(lineSpanForSelection("aa\nbb\ncc", 0, 7)).toEqual({ from: 0, to: 8 });
  });

  it("stops one line short when a multi-line selection's exclusive end lands at the start of a later line", () => {
    // Same text; to === 6 is column 1 of line 3, so the span covers only
    // lines 1-2, not line 3 — the multi-line generalization of the core
    // issue #99 case above.
    expect(lineSpanForSelection("aa\nbb\ncc", 0, 6)).toEqual({ from: 0, to: 5 });
  });

  it("covers the last line correctly when the document has no trailing newline", () => {
    expect(lineSpanForSelection("a\nb", 2, 3)).toEqual({ from: 2, to: 3 });
  });

  it("excludes a following empty line the same way it excludes a following non-empty one", () => {
    // "a\n\nb": selecting [0, 2) is "a" plus its newline, ending at column
    // 1 of the empty line 2. The empty line must stay excluded, same as
    // the core issue #99 case, even though "including" it would not have
    // added any visible characters.
    expect(lineSpanForSelection("a\n\nb", 0, 2)).toEqual({ from: 0, to: 1 });
  });

  it("keeps a selection inside a leading empty line from spilling into line 2", () => {
    // "\nfoo": line 1 is empty (from 0 to 0, since the very first
    // character is already the newline). Selecting [0, 1) selects only
    // line 1's terminating newline; the span must stay zero-width at
    // {0, 0} and must not resolve to line 2 ("foo") just because position
    // 0 sits right next to it across that newline.
    expect(lineSpanForSelection("\nfoo", 0, 1)).toEqual({ from: 0, to: 0 });
  });

  it("spans the whole document for a single-line file with no newline at all", () => {
    expect(lineSpanForSelection("only", 0, 4)).toEqual({ from: 0, to: 4 });
  });

  it("only ever sees a normalized from <= to, regardless of which end of the selection the user dragged from", () => {
    // CM6's SelectionRange.from/.to are always position-ordered (.anchor/
    // .head are what carry drag direction), so a backward drag (anchor
    // after head) still normalizes to the same from/to pair as a forward
    // drag would for the same endpoints — there is no separate "backward"
    // case for this function to handle.
    expect(lineSpanForSelection("xx\nyyy", 0, 6)).toEqual({ from: 0, to: 6 });
  });

  it("throws for an empty selection instead of returning a nonsensical range", () => {
    // A cursor (from === to) is not a line span at all: transformLines
    // gives an empty selection its own whole-document meaning and never
    // calls this function for that case (see editor.ts). Guarding here
    // means a future caller that forgets the range.empty check fails
    // loudly instead of silently getting back an inverted {from, to}.
    expect(() => lineSpanForSelection("b\na\nc", 2, 2)).toThrow();
  });
});
