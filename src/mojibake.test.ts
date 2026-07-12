import { describe, expect, it } from "vitest";
import { describeCandidate, isMojibakeSnapshotStale, truncatePreview } from "./mojibake";
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

// Issue #93: detection and the user's candidate pick are both async, so the
// same tab's content can keep changing while the wizard is open. Applying a
// repair computed from a stale snapshot would silently overwrite whatever
// the user typed in the meantime — these are the failing-first tests for
// the guard that rejects that instead of a plain tab-id check.
describe("isMojibakeSnapshotStale", () => {
  it("is not stale when the live content still matches the snapshot", () => {
    const content = "these violets are actually 這是亂碼";
    expect(isMojibakeSnapshotStale(content, content)).toBe(false);
  });

  it("is not stale when an edit was undone back to the exact snapshot", () => {
    // A value comparison (not a generation counter) means content edited
    // and then reverted to byte-for-byte the snapshot is correctly not
    // stale — the repair still applies to identical content.
    const snapshot = "these violets are actually 這是亂碼";
    const editedThenReverted = snapshot.slice();
    expect(isMojibakeSnapshotStale(snapshot, editedThenReverted)).toBe(false);
  });

  it("is stale for the smallest possible single-character edit", () => {
    const snapshot = "these violets are actually 這是亂碼";
    expect(isMojibakeSnapshotStale(snapshot, snapshot + " ")).toBe(true);
  });

  it("is stale when the same tab was edited after the snapshot was taken", () => {
    const snapshot = "original mojibake content";
    // Simulates the user typing in the same tab while the wizard's async
    // detect -> pick -> repair round trip was still in flight.
    const liveContent = "original mojibake content, plus a new sentence.";
    expect(isMojibakeSnapshotStale(snapshot, liveContent)).toBe(true);
  });

  it("is stale even for a whitespace-only change", () => {
    expect(isMojibakeSnapshotStale("line one\nline two", "line one\n\nline two")).toBe(true);
  });

  it("is not stale when both snapshot and live content are empty", () => {
    expect(isMojibakeSnapshotStale("", "")).toBe(false);
  });
});
