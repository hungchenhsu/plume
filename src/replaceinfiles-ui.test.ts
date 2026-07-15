import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import type { ReplaceExecuteEntry, ReplaceScanEntry } from "./ipc";
import {
  buildPreviewRows,
  buildReplaceConfirmMessage,
  previewTotals,
  selectedReplaceTargets,
  selectionTotals,
  summarizeReplaceResults,
  skipReasonLabel,
} from "./replaceinfiles-ui";

function scanEntry(overrides: Partial<ReplaceScanEntry> = {}): ReplaceScanEntry {
  return {
    path: "/a.txt",
    matchCount: 1,
    encoding: "UTF-8",
    fingerprint: { size: 10, mtime: 123 },
    lossy: false,
    skippedReason: null,
    ...overrides,
  };
}

function execEntry(overrides: Partial<ReplaceExecuteEntry> = {}): ReplaceExecuteEntry {
  return {
    path: "/a.txt",
    replacedCount: 1,
    status: "ok",
    message: "",
    ...overrides,
  };
}

// The exact, constant skippedReason strings replaceinfiles.rs's
// scan_one_file emits (see its skipped_entry call sites) — used here to
// pin the pure classifier against the real backend contract rather than
// an invented string.
const OVERSIZED_REASON = "File exceeds the 5 MiB search cap";
const MALFORMED_REASON =
  "File does not decode cleanly under detection; skipped, not searched";

describe("skipReasonLabel", () => {
  it("labels the exact oversized reason distinctly from the raw text", () => {
    const label = skipReasonLabel(OVERSIZED_REASON);
    expect(label).not.toBe(OVERSIZED_REASON);
    expect(label).toBe(t("findInFiles.skipReasonOversized"));
  });

  it("labels the exact malformed/decode-error reason distinctly from the raw text", () => {
    const label = skipReasonLabel(MALFORMED_REASON);
    expect(label).not.toBe(MALFORMED_REASON);
    expect(label).toBe(t("findInFiles.skipReasonMalformed"));
  });

  it("falls back to a generic io-error label for any other (dynamic OS-error) reason", () => {
    const dynamic = "Failed to read: Permission denied (os error 13)";
    const label = skipReasonLabel(dynamic);
    expect(label).not.toBe(dynamic);
    expect(label).toBe(t("findInFiles.skipReasonIoError"));
  });
});

describe("buildPreviewRows", () => {
  it("carries a selectable entry's fields through with no skip label", () => {
    const rows = buildPreviewRows([
      scanEntry({ path: "/a.txt", matchCount: 3, encoding: "Big5", lossy: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/a.txt");
    expect(rows[0].encoding).toBe("Big5");
    expect(rows[0].lossy).toBe(true);
    expect(rows[0].selectable).toBe(true);
    expect(rows[0].skipLabel).toBeNull();
    expect(rows[0].skipTitle).toBeNull();
    expect(rows[0].matchCountLabel).toBe(t("findInFiles.replaceMatchCount", 3));
  });

  it("marks a skipped entry unselectable and attaches both a localized label and the raw reason as title", () => {
    const rows = buildPreviewRows([
      scanEntry({
        path: "/huge.txt",
        matchCount: 0,
        encoding: "",
        lossy: false,
        skippedReason: OVERSIZED_REASON,
      }),
    ]);
    expect(rows[0].selectable).toBe(false);
    expect(rows[0].skipLabel).toBe(t("findInFiles.skipReasonOversized"));
    expect(rows[0].skipTitle).toBe(OVERSIZED_REASON);
  });

  it("preserves report order across a mix of selectable and skipped entries", () => {
    const rows = buildPreviewRows([
      scanEntry({ path: "/a.txt" }),
      scanEntry({ path: "/b.txt", skippedReason: MALFORMED_REASON }),
      scanEntry({ path: "/c.txt" }),
    ]);
    expect(rows.map((r) => r.path)).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
    expect(rows.map((r) => r.selectable)).toEqual([true, false, true]);
  });

  it("returns an empty array for an empty report", () => {
    expect(buildPreviewRows([])).toEqual([]);
  });
});

describe("previewTotals", () => {
  it("sums matchCount and counts files only over non-skipped entries", () => {
    const totals = previewTotals([
      scanEntry({ path: "/a.txt", matchCount: 2 }),
      scanEntry({ path: "/b.txt", matchCount: 5 }),
    ]);
    expect(totals).toEqual({ fileCount: 2, matchCount: 7, skippedCount: 0 });
  });

  it("tallies skipped entries separately, excluded from fileCount/matchCount", () => {
    const totals = previewTotals([
      scanEntry({ path: "/a.txt", matchCount: 2 }),
      scanEntry({ path: "/huge.txt", matchCount: 0, skippedReason: OVERSIZED_REASON }),
    ]);
    expect(totals).toEqual({ fileCount: 1, matchCount: 2, skippedCount: 1 });
  });

  it("returns all zeros for an empty report", () => {
    expect(previewTotals([])).toEqual({ fileCount: 0, matchCount: 0, skippedCount: 0 });
  });
});

describe("selectionTotals", () => {
  it("with nothing unchecked, totals every non-skipped entry (all-checked default)", () => {
    const entries = [
      scanEntry({ path: "/a.txt", matchCount: 2, lossy: false }),
      scanEntry({ path: "/b.txt", matchCount: 3, lossy: true }),
    ];
    expect(selectionTotals(entries, new Set())).toEqual({
      fileCount: 2,
      matchCount: 5,
      lossyFileCount: 1,
    });
  });

  it("excludes explicitly unchecked entries from every total", () => {
    const entries = [
      scanEntry({ path: "/a.txt", matchCount: 2, lossy: true }),
      scanEntry({ path: "/b.txt", matchCount: 3, lossy: false }),
    ];
    expect(selectionTotals(entries, new Set(["/a.txt"]))).toEqual({
      fileCount: 1,
      matchCount: 3,
      lossyFileCount: 0,
    });
  });

  it("never lets a skipped entry count, even if absent from uncheckedPaths", () => {
    const entries = [
      scanEntry({ path: "/a.txt", matchCount: 2 }),
      scanEntry({
        path: "/huge.txt",
        matchCount: 0,
        skippedReason: OVERSIZED_REASON,
        lossy: false,
      }),
    ];
    expect(selectionTotals(entries, new Set())).toEqual({
      fileCount: 1,
      matchCount: 2,
      lossyFileCount: 0,
    });
  });

  it("ignores stale paths in uncheckedPaths that match no entry", () => {
    const entries = [scanEntry({ path: "/a.txt", matchCount: 2 })];
    expect(selectionTotals(entries, new Set(["/gone.txt"]))).toEqual({
      fileCount: 1,
      matchCount: 2,
      lossyFileCount: 0,
    });
  });
});

// The task's required "勾選集轉換排除 skipped" pure function.
describe("selectedReplaceTargets", () => {
  it("converts every checked, non-skipped entry to a {path, expectedFingerprint} target", () => {
    const entries = [
      scanEntry({ path: "/a.txt", fingerprint: { size: 1, mtime: 1 } }),
      scanEntry({ path: "/b.txt", fingerprint: { size: 2, mtime: 2 } }),
    ];
    expect(selectedReplaceTargets(entries, new Set())).toEqual([
      { path: "/a.txt", expectedFingerprint: { size: 1, mtime: 1 } },
      { path: "/b.txt", expectedFingerprint: { size: 2, mtime: 2 } },
    ]);
  });

  it("excludes a skipped entry from the execute targets even when checked/unmarked", () => {
    const entries = [
      scanEntry({ path: "/a.txt" }),
      scanEntry({
        path: "/huge.txt",
        skippedReason: OVERSIZED_REASON,
        fingerprint: null,
      }),
    ];
    const targets = selectedReplaceTargets(entries, new Set());
    expect(targets).toHaveLength(1);
    expect(targets[0].path).toBe("/a.txt");
    expect(targets.some((tgt) => tgt.path === "/huge.txt")).toBe(false);
  });

  it("excludes an explicitly-unchecked selectable entry", () => {
    const entries = [
      scanEntry({ path: "/a.txt" }),
      scanEntry({ path: "/b.txt" }),
    ];
    const targets = selectedReplaceTargets(entries, new Set(["/b.txt"]));
    expect(targets.map((tgt) => tgt.path)).toEqual(["/a.txt"]);
  });

  it("passes a null fingerprint through as-is rather than substituting a default", () => {
    const entries = [scanEntry({ path: "/a.txt", fingerprint: null })];
    expect(selectedReplaceTargets(entries, new Set())).toEqual([
      { path: "/a.txt", expectedFingerprint: null },
    ]);
  });

  it("returns an empty array when every entry is skipped", () => {
    const entries = [
      scanEntry({ path: "/a.txt", skippedReason: OVERSIZED_REASON }),
      scanEntry({ path: "/b.txt", skippedReason: MALFORMED_REASON }),
    ];
    expect(selectedReplaceTargets(entries, new Set())).toEqual([]);
  });
});

// The task's required "確認訊息組字含 lossy 警語" pure function — the core
// quality axis of this whole feature (destructive multi-file write, and the
// wording must not gloss over what a lossy write actually does: encoding_rs
// substitutes a literal HTML numeric character reference, never fails
// outright — see src-tauri/src/streamcodec.rs's encode_chunk doc comment).
describe("buildReplaceConfirmMessage", () => {
  it("omits any lossy wording when lossyFileCount is 0", () => {
    const message = buildReplaceConfirmMessage(5, 12, 0);
    expect(message).toBe(t("findInFiles.replaceConfirmMessage", 5, 12));
    expect(message).not.toContain("&#");
    expect(message.toLowerCase()).not.toContain("numeric character reference");
  });

  it("names the lossy file count and explains the HTML numeric character reference fallback when lossyFileCount > 0", () => {
    const message = buildReplaceConfirmMessage(5, 12, 2);
    expect(message).toBe(t("findInFiles.replaceConfirmMessageLossy", 5, 12, 2));
    // The exact semantics (S1-reviewed app behavior): an unmappable
    // replacement character is not rejected, it is written as a literal
    // "&#NNNN;" numeric character reference. The wording must say so
    // explicitly, not gloss over it.
    expect(message).toContain("&#");
    expect(message.toLowerCase()).toContain("numeric character reference");
    expect(message).toContain("2");
  });

  it("still states the file/match counts in the lossy branch, not just the warning", () => {
    const message = buildReplaceConfirmMessage(5, 12, 2);
    expect(message).toContain("5");
    expect(message).toContain("12");
  });

  it("the lossy and non-lossy messages for the same counts are never identical", () => {
    const plain = buildReplaceConfirmMessage(5, 12, 0);
    const lossy = buildReplaceConfirmMessage(5, 12, 1);
    expect(plain).not.toBe(lossy);
  });
});

// The task's required "結果摘要分類" pure function.
describe("summarizeReplaceResults", () => {
  it("tallies ok entries into okCount/totalReplacements and reports no failed groups", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", replacedCount: 3, status: "ok" }),
      execEntry({ path: "/b.txt", replacedCount: 4, status: "ok" }),
    ]);
    expect(summary.okCount).toBe(2);
    expect(summary.totalReplacements).toBe(7);
    expect(summary.failedGroups).toEqual([]);
  });

  it("groups changed_since_scan, lossy_blocked, and io_error into separate labeled groups", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", status: "ok", replacedCount: 1 }),
      execEntry({ path: "/b.txt", status: "changed_since_scan", replacedCount: 0 }),
      execEntry({ path: "/c.txt", status: "lossy_blocked", replacedCount: 0 }),
      execEntry({ path: "/d.txt", status: "io_error", replacedCount: 0 }),
    ]);
    expect(summary.okCount).toBe(1);
    const statuses = summary.failedGroups.map((g) => g.status);
    expect(statuses).toEqual(["changed_since_scan", "lossy_blocked", "io_error"]);
    expect(summary.failedGroups.find((g) => g.status === "changed_since_scan")?.entries).toHaveLength(1);
    // Every group must carry a non-empty, localized label distinct from the
    // raw status string (the task's i18n requirement extended to the
    // result-summary classification, mirroring the skip-reason labeling).
    for (const group of summary.failedGroups) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.label).not.toBe(group.status);
    }
  });

  it("uses the exact required wording for changed_since_scan", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", status: "changed_since_scan", replacedCount: 0 }),
    ]);
    expect(summary.failedGroups[0].label).toBe(
      t("findInFiles.replaceStatusChangedSinceScan"),
    );
  });

  it("never lets a failed entry's replacedCount leak into totalReplacements", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", status: "ok", replacedCount: 2 }),
      execEntry({ path: "/b.txt", status: "io_error", replacedCount: 0 }),
    ]);
    expect(summary.totalReplacements).toBe(2);
  });

  it("returns zero/empty for an empty result set", () => {
    const summary = summarizeReplaceResults([]);
    expect(summary).toEqual({ okCount: 0, totalReplacements: 0, failedGroups: [] });
  });

  it("still surfaces an unrecognized status in its own group rather than dropping it silently", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", status: "something_new", replacedCount: 0 }),
    ]);
    expect(summary.failedGroups).toHaveLength(1);
    expect(summary.failedGroups[0].entries).toHaveLength(1);
    expect(summary.failedGroups[0].entries[0].path).toBe("/a.txt");
  });

  it("keeps failure groups in a fixed, deterministic order regardless of input order", () => {
    const summary = summarizeReplaceResults([
      execEntry({ path: "/a.txt", status: "io_error" }),
      execEntry({ path: "/b.txt", status: "changed_since_scan" }),
    ]);
    expect(summary.failedGroups.map((g) => g.status)).toEqual([
      "changed_since_scan",
      "io_error",
    ]);
  });
});
