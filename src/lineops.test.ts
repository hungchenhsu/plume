// See CLAUDE.md "Frontend logic that doesn't need the WebView" — these are
// plain string->string functions, fully covered without CodeMirror or
// jsdom. The view-layer callers (`EditorHandle.transformLines` /
// `transformSelection` in editor.ts) dispatch into a live CM6 EditorView
// and are not covered here for the same reason editor.test.ts only covers
// `eolMarkPositions`: jsdom has no real layout engine for CM6 to run
// against.
import { describe, expect, it } from "vitest";
import {
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
