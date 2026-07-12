import { describe, expect, it } from "vitest";
import { describeCandidate, truncatePreview } from "./mojibake";
import type { RepairCandidate } from "./ipc";

describe("truncatePreview", () => {
  it("returns text unchanged when under the limit", () => {
    expect(truncatePreview("hello", 200)).toBe("hello");
  });

  it("truncates to exactly maxChars code points", () => {
    expect(truncatePreview("abcdef", 3)).toBe("abc");
  });

  it("counts multi-byte CJK characters as one each, not by UTF-16 unit", () => {
    const text = "中文編碼偵測測試";
    expect(truncatePreview(text, 4)).toBe("中文編碼");
  });

  it("never splits a surrogate pair (emoji) at the cut point", () => {
    // "🚀" is one code point but two UTF-16 code units; a naive
    // string.slice(0, 1) would cut it in half and produce a lone
    // surrogate. Array.from-based truncation must keep it whole.
    const text = "🚀🚀🚀";
    const truncated = truncatePreview(text, 2);
    expect(Array.from(truncated)).toHaveLength(2);
    expect(truncated).toBe("🚀🚀");
  });

  it("handles an empty string", () => {
    expect(truncatePreview("", 200)).toBe("");
  });
});

describe("describeCandidate", () => {
  it("describes the mis-decode in terms of original and intermediate encodings", () => {
    const candidate: RepairCandidate = {
      intermediate: "windows-1252",
      original: "Big5",
      preview: "中文",
      replacementCount: 42,
    };
    expect(describeCandidate(candidate)).toBe(
      "Looks like Big5 content that was decoded as windows-1252 by mistake.",
    );
  });

  it("uses the candidate's own labels verbatim, not a fixed encoding list", () => {
    const candidate: RepairCandidate = {
      intermediate: "Shift_JIS",
      original: "EUC-KR",
      preview: "",
      replacementCount: 1,
    };
    expect(describeCandidate(candidate)).toContain("EUC-KR");
    expect(describeCandidate(candidate)).toContain("Shift_JIS");
  });
});
