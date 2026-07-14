import { describe, expect, it } from "vitest";
import { formatCodePoint, formatSize } from "./statusbar";

describe("formatSize", () => {
  it("formats kilobytes with a floor of 1 KB", () => {
    expect(formatSize(10)).toBe("1 KB");
    expect(formatSize(2048)).toBe("2 KB");
  });

  it("formats megabytes without decimals", () => {
    expect(formatSize(12 * 1024 * 1024)).toBe("12 MB");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});

// ROADMAP.md v0.4 Track A character inspector.
describe("formatCodePoint", () => {
  it("formats an ASCII character, zero-padded to 4 digits", () => {
    expect(formatCodePoint("A")).toBe("U+0041");
  });

  it("formats a CJK character", () => {
    expect(formatCodePoint("中")).toBe("U+4E2D");
  });

  it("formats a supplementary-plane character (surrogate pair) as its one assembled code point", () => {
    expect(formatCodePoint("\u{1F600}")).toBe("U+1F600");
  });

  it("uses the first code point when given more than one character", () => {
    // Defensive: callers only ever pass a single code point in practice
    // (see editor.ts's characterBeforeCursor), but this pins that the
    // helper itself doesn't silently read the wrong one.
    expect(formatCodePoint("AB")).toBe("U+0041");
  });
});
