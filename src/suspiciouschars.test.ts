// Curated invisible/ambiguous character audit (ROADMAP.md v0.4 Track A).
// Pure module, no CM6 import — see suspiciouschars.ts's header comment.
// The expected (codePoint, label, category) triples below are written
// independently of the implementation, straight from the ROADMAP.md spec's
// own enumeration, so this suite actually pins the *specified* set rather
// than just echoing back whatever the table happens to contain.
//
// Every fixture uses \uXXXX escapes rather than literal characters embedded
// in this file's source: several of these code points (the bidi overrides
// in particular) visually reorder whatever text follows them until a
// terminator appears, so writing them in literally would risk scrambling
// how this very file renders in an editor/diff/terminal — exactly the
// class of hazard this feature exists to flag. Escapes keep every fixture
// legible as plain ASCII source.
import { describe, expect, it } from "vitest";
import {
  CURATED_CHARS,
  scanSuspiciousChars,
  SUSPICIOUS_CHARS_PATTERN,
  suspiciousCharFor,
  type SuspiciousCharCategory,
} from "./suspiciouschars";

const BIDI: [number, string][] = [
  [0x202a, "LRE"],
  [0x202b, "RLE"],
  [0x202c, "PDF"],
  [0x202d, "LRO"],
  [0x202e, "RLO"],
  [0x2066, "LRI"],
  [0x2067, "RLI"],
  [0x2068, "FSI"],
  [0x2069, "PDI"],
  [0x061c, "ALM"],
  [0x200e, "LRM"],
  [0x200f, "RLM"],
];

const ZERO_WIDTH: [number, string][] = [
  [0x200b, "ZWSP"],
  [0x200c, "ZWNJ"],
  [0x200d, "ZWJ"],
  [0x2060, "WJ"],
  [0xfeff, "BOM"],
];

const WHITESPACE: [number, string][] = [
  [0x00a0, "NBSP"],
  [0x202f, "NNBSP"],
  [0x00ad, "SHY"],
];

const ALL_CURATED: [number, string, SuspiciousCharCategory][] = [
  ...BIDI.map(([cp, label]): [number, string, SuspiciousCharCategory] => [cp, label, "bidi"]),
  ...ZERO_WIDTH.map(([cp, label]): [number, string, SuspiciousCharCategory] => [
    cp,
    label,
    "zeroWidth",
  ]),
  ...WHITESPACE.map(([cp, label]): [number, string, SuspiciousCharCategory] => [
    cp,
    label,
    "whitespace",
  ]),
];

function sortedCodePoints(points: number[]): number[] {
  return [...points].sort((a, b) => a - b);
}

/** Build a string from UTF-16 code units by numeric value — avoids ever
 *  typing a literal invisible/bidi character in this file's source (see
 *  the module doc comment above). */
function chars(...codeUnits: number[]): string {
  return String.fromCharCode(...codeUnits);
}

describe("CURATED_CHARS", () => {
  it("has exactly the 20 code points the ROADMAP.md spec enumerates, no more, no fewer", () => {
    const actual = sortedCodePoints(CURATED_CHARS.map((entry) => entry.codePoint));
    const expected = sortedCodePoints(ALL_CURATED.map(([cp]) => cp));
    expect(actual).toEqual(expected);
  });

  it("has no duplicate code points", () => {
    const codePoints = CURATED_CHARS.map((entry) => entry.codePoint);
    expect(new Set(codePoints).size).toBe(codePoints.length);
  });

  it("gives every entry a non-empty label and name", () => {
    for (const entry of CURATED_CHARS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  // U+3000 (ideographic space) is explicitly excluded per spec — routine
  // CJK punctuation-width spacing, not a disguised/invisible character.
  it("excludes U+3000 (ideographic space) — legitimate CJK use, not audited", () => {
    expect(suspiciousCharFor(0x3000)).toBeUndefined();
  });
});

describe("suspiciousCharFor", () => {
  it.each(ALL_CURATED)("resolves U+%s to label %s (%s)", (codePoint, label, category) => {
    const entry = suspiciousCharFor(codePoint);
    expect(entry?.label).toBe(label);
    expect(entry?.category).toBe(category);
  });

  it("returns undefined for an ordinary ASCII character", () => {
    expect(suspiciousCharFor(0x41)).toBeUndefined(); // "A"
  });

  it("returns undefined for a CJK character", () => {
    expect(suspiciousCharFor("中".charCodeAt(0))).toBeUndefined();
  });

  it("returns undefined for a plain space", () => {
    expect(suspiciousCharFor(0x20)).toBeUndefined();
  });
});

describe("SUSPICIOUS_CHARS_PATTERN", () => {
  it("matches every curated character", () => {
    for (const [codePoint] of ALL_CURATED) {
      expect(SUSPICIOUS_CHARS_PATTERN.test(chars(codePoint))).toBe(true);
    }
  });

  it("does not match ordinary text, including the excluded U+3000", () => {
    for (const char of ["a", "中", "0", " ", chars(0x3000), "\n", "\t"]) {
      expect(SUSPICIOUS_CHARS_PATTERN.test(char)).toBe(false);
    }
  });
});

describe("scanSuspiciousChars", () => {
  it("finds nothing in ordinary text (no audited characters)", () => {
    expect(scanSuspiciousChars("hello world, 你好，世界！ 123")).toEqual([]);
  });

  it("finds nothing in an empty string", () => {
    expect(scanSuspiciousChars("")).toEqual([]);
  });

  it.each(BIDI)("detects the bidi control %s at its offset", (codePoint, label) => {
    const text = chars(0x61, 0x62, codePoint, 0x63, 0x64); // "ab" + char + "cd"
    const hits = scanSuspiciousChars(text);
    expect(hits).toEqual([
      { offset: 2, char: chars(codePoint), label, name: expect.any(String), category: "bidi" },
    ]);
  });

  it.each(ZERO_WIDTH)("detects the zero-width character %s at its offset", (codePoint, label) => {
    const text = chars(0x61, 0x62, codePoint, 0x63, 0x64);
    const hits = scanSuspiciousChars(text);
    expect(hits).toEqual([
      {
        offset: 2,
        char: chars(codePoint),
        label,
        name: expect.any(String),
        category: "zeroWidth",
      },
    ]);
  });

  it.each(WHITESPACE)("detects the whitespace variant %s at its offset", (codePoint, label) => {
    const text = chars(0x61, 0x62, codePoint, 0x63, 0x64);
    const hits = scanSuspiciousChars(text);
    expect(hits).toEqual([
      {
        offset: 2,
        char: chars(codePoint),
        label,
        name: expect.any(String),
        category: "whitespace",
      },
    ]);
  });

  it("finds a mix of categories in one string, in document order, each at its correct offset", () => {
    // "a" + RLO (bidi) + "b" + ZWSP (zeroWidth) + "c" + NBSP (whitespace) + "d"
    const text = chars(0x61, 0x202e, 0x62, 0x200b, 0x63, 0x00a0, 0x64);
    const hits = scanSuspiciousChars(text);
    expect(hits.map((h) => [h.offset, h.label, h.category])).toEqual([
      [1, "RLO", "bidi"],
      [3, "ZWSP", "zeroWidth"],
      [5, "NBSP", "whitespace"],
    ]);
  });

  it("counts repeated occurrences of the same character separately", () => {
    const hits = scanSuspiciousChars(chars(0x200b, 0x200b, 0x200b));
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.offset)).toEqual([0, 1, 2]);
  });

  // All 20 curated code points are single UTF-16 code units in the Basic
  // Multilingual Plane (none in the D800-DFFF surrogate range), so a
  // supplementary-plane character (a surrogate pair, e.g. an emoji) sitting
  // immediately next to a curated character must neither hide it nor get
  // miscounted/split itself — see scanSuspiciousChars's doc comment for why
  // no cross-chunk carry state is even needed here, unlike textstats.ts's
  // word counter.
  it("detects a curated character immediately after a surrogate pair without disturbing it", () => {
    const text = "\u{1F600}" + chars(0x200b); // grinning-face emoji (2 units) + ZWSP
    const hits = scanSuspiciousChars(text);
    expect(hits).toEqual([
      {
        offset: 2,
        char: chars(0x200b),
        label: "ZWSP",
        name: expect.any(String),
        category: "zeroWidth",
      },
    ]);
  });

  it("detects a curated character immediately before a surrogate pair without disturbing it", () => {
    const text = chars(0x200b) + "\u{1F600}"; // ZWSP + grinning-face emoji (2 units)
    const hits = scanSuspiciousChars(text);
    expect(hits).toEqual([
      {
        offset: 0,
        char: chars(0x200b),
        label: "ZWSP",
        name: expect.any(String),
        category: "zeroWidth",
      },
    ]);
  });

  it("never matches either half of a surrogate pair on its own", () => {
    const text = "\u{1F600}"; // high surrogate D83D + low surrogate DE00
    expect(scanSuspiciousChars(text)).toEqual([]);
  });

  it("handles several supplementary-plane characters with curated characters woven between them", () => {
    const text =
      "\u{1F600}" + chars(0x202e) + "\u{1F601}" + chars(0x00ad) + "\u{1F602}";
    const hits = scanSuspiciousChars(text);
    // Offsets are UTF-16 code-unit offsets: each emoji occupies 2 units.
    expect(hits.map((h) => [h.offset, h.label])).toEqual([
      [2, "RLO"],
      [5, "SHY"],
    ]);
  });
});
