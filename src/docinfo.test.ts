import { describe, expect, it } from "vitest";
import { buildDocumentInfoDialogContent, formatDateTime, type DocInfoFetch } from "./docinfo";
import type { DetectionExplanation, DocumentMetadata, LineEndingDistribution } from "./ipc";

const okMetadata: DocInfoFetch<DocumentMetadata> = {
  status: "ok",
  data: { size: 2048, modifiedMs: 1_700_000_000_000 },
};

const cleanDetection: DetectionExplanation = {
  bom: null,
  detectorVerdict: "UTF-8",
  sampledBytes: 2048,
  totalSize: 2048,
  wouldChoose: "UTF-8 (detector)",
  largeFilePreview: false,
};

const okDetection: DocInfoFetch<DetectionExplanation> = { status: "ok", data: cleanDetection };

const exactLineEnding: DocInfoFetch<LineEndingDistribution> = {
  status: "ok",
  data: { lf: 10, crlf: 0, cr: 0, scannedBytes: 2048, totalSize: 2048 },
};

function baseInput() {
  return {
    path: "/home/user/notes.txt",
    title: "notes.txt",
    encoding: "UTF-8",
    withBom: false,
    lineEnding: "LF",
    metadata: okMetadata,
    detection: okDetection,
    lineEndingDist: exactLineEnding,
    textStats: { stats: { chars: 100, words: 20, lines: 10 }, selected: false },
  };
}

describe("buildDocumentInfoDialogContent — untitled tab (no path)", () => {
  const model = buildDocumentInfoDialogContent({
    ...baseInput(),
    path: null,
    title: "Untitled-1",
    metadata: { status: "skipped", reason: "untitled" },
    detection: { status: "skipped", reason: "untitled" },
    lineEndingDist: { status: "skipped", reason: "untitled" },
  });

  it("titles the dialog after the buffer's own title", () => {
    expect(model.title).toBe("Document Info — Untitled-1");
  });

  it("shows only the unsaved-marker path row, no size/modified rows or notes", () => {
    expect(model.fileSection.rows).toEqual([
      { label: "Path", value: "Untitled-1 (not saved yet)" },
    ]);
    expect(model.fileSection.notes).toEqual([]);
  });

  it("shows only the encoding+BOM row, no detection evidence", () => {
    expect(model.encodingSection.rows).toEqual([{ label: "Encoding", value: "UTF-8" }]);
    expect(model.encodingSection.notes).toEqual([]);
  });

  it("shows only the line-ending summary row, no distribution counts or UTF-16 note", () => {
    expect(model.lineEndingSection.rows).toEqual([{ label: "Line Ending", value: "LF" }]);
    expect(model.lineEndingSection.notes).toEqual([]);
  });

  it("still shows text stats — computed from the live buffer, no disk access needed", () => {
    expect(model.textStatsSection).not.toBeNull();
  });
});

describe("buildDocumentInfoDialogContent — a real file, everything resolves cleanly", () => {
  const model = buildDocumentInfoDialogContent(baseInput());

  it("shows path, size and modified rows", () => {
    expect(model.fileSection.rows).toEqual([
      { label: "Path", value: "/home/user/notes.txt" },
      { label: "Size", value: "2 KB" },
      { label: "Modified", value: expect.any(String) },
    ]);
    expect(model.fileSection.notes).toEqual([]);
  });

  it("shows the encoding row plus detection evidence rows, no BOM suffix when withBom is false", () => {
    expect(model.encodingSection.rows[0]).toEqual({ label: "Encoding", value: "UTF-8" });
    expect(model.encodingSection.rows).toContainEqual({ label: "BOM", value: "No BOM found" });
    expect(model.encodingSection.rows).toContainEqual({
      label: "chardetng verdict",
      value: "UTF-8",
    });
    // Matching encoding, no truncation: no notes at all.
    expect(model.encodingSection.notes).toEqual([]);
  });

  it("appends ' BOM' to the encoding row's value when withBom is true", () => {
    const withBomModel = buildDocumentInfoDialogContent({ ...baseInput(), withBom: true });
    expect(withBomModel.encodingSection.rows[0]).toEqual({
      label: "Encoding",
      value: "UTF-8 BOM",
    });
  });

  it("surfaces the manual-override note when the current encoding differs from auto-detect", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      encoding: "Big5",
      detection: okDetection,
    });
    expect(model.encodingSection.notes).toContainEqual(
      expect.stringContaining("Currently using Big5 manually"),
    );
  });

  it("shows LF/CRLF/CR distribution rows plus an exact 'Scanned' row and no sampled note", () => {
    expect(model.lineEndingSection.rows).toEqual([
      { label: "Line Ending", value: "LF" },
      { label: "LF (Unix / macOS)", value: "10" },
      { label: "CRLF (Windows)", value: "0" },
      { label: "CR (Classic Mac)", value: "0" },
      { label: "Scanned", value: "all 2 KB" },
    ]);
    expect(model.lineEndingSection.notes).toEqual([]);
  });

  it("uses the whole-document text-stats template when nothing is selected", () => {
    expect(model.textStatsSection).toEqual({
      rows: [{ label: "Word/Character/Line Count", value: "20 words, 100 chars, 10 lines" }],
      notes: [],
    });
  });

  it("uses the selection text-stats template when a selection is active", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      textStats: { stats: { chars: 5, words: 1, lines: 1 }, selected: true },
    });
    expect(model.textStatsSection?.rows[0].value).toBe("Selected: 1 word, 5 chars, 1 line");
  });

  it("omits the text-stats section entirely for a truncated large-file window", () => {
    const model = buildDocumentInfoDialogContent({ ...baseInput(), textStats: null });
    expect(model.textStatsSection).toBeNull();
  });
});

describe("buildDocumentInfoDialogContent — bounded line-ending scan disclosure", () => {
  it("shows a 'first N of M' Scanned row and an explicit sampled note when the scan was bounded", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      lineEndingDist: {
        status: "ok",
        data: { lf: 900, crlf: 0, cr: 0, scannedBytes: 10 * 1024 * 1024, totalSize: 15 * 1024 * 1024 },
      },
    });
    expect(model.lineEndingSection.rows).toContainEqual({
      label: "Scanned",
      value: "first 10 MB of 15 MB",
    });
    expect(model.lineEndingSection.notes).toEqual([
      "Counted from the first 10 MB of this file only — these counts do not reflect the whole file.",
    ]);
  });

  it("never shows a sampled note when the scan covered the whole file", () => {
    const model = buildDocumentInfoDialogContent(baseInput());
    expect(model.lineEndingSection.notes).toEqual([]);
  });
});

describe("buildDocumentInfoDialogContent — UTF-16 line-ending exclusion", () => {
  it("shows the UTF-16 note instead of distribution rows, leaving the summary row intact", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      encoding: "UTF-16LE",
      lineEnding: "CRLF",
      lineEndingDist: { status: "skipped", reason: "utf16" },
    });
    expect(model.lineEndingSection.rows).toEqual([{ label: "Line Ending", value: "CRLF" }]);
    expect(model.lineEndingSection.notes).toEqual([
      "Line-ending distribution isn't available for UTF-16 files.",
    ]);
  });
});

describe("buildDocumentInfoDialogContent — per-section IO error resilience", () => {
  it("shows a load-error note for the file section without touching the other sections", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      metadata: { status: "error", message: "Failed to read /home/user/notes.txt: No such file" },
    });
    expect(model.fileSection.rows).toEqual([{ label: "Path", value: "/home/user/notes.txt" }]);
    expect(model.fileSection.notes).toEqual([
      "Couldn't load this information: Failed to read /home/user/notes.txt: No such file",
    ]);
    // Unaffected.
    expect(model.encodingSection.notes).toEqual([]);
    expect(model.lineEndingSection.notes).toEqual([]);
  });

  it("shows a load-error note for the encoding section without touching the other sections", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      detection: { status: "error", message: "boom" },
    });
    expect(model.encodingSection.rows).toEqual([{ label: "Encoding", value: "UTF-8" }]);
    expect(model.encodingSection.notes).toEqual(["Couldn't load this information: boom"]);
    expect(model.fileSection.notes).toEqual([]);
  });

  it("shows a load-error note for the line-ending section without touching the other sections", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      lineEndingDist: { status: "error", message: "disk gone" },
    });
    expect(model.lineEndingSection.rows).toEqual([{ label: "Line Ending", value: "LF" }]);
    expect(model.lineEndingSection.notes).toEqual([
      "Couldn't load this information: disk gone",
    ]);
    expect(model.fileSection.notes).toEqual([]);
    expect(model.encodingSection.notes).toEqual([]);
  });
});

describe("formatDateTime", () => {
  it("delegates to Date#toLocaleString for a positive epoch offset", () => {
    expect(formatDateTime(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toLocaleString());
  });

  it("does not throw for a negative (pre-epoch) offset and still returns a string", () => {
    expect(formatDateTime(-3_600_000)).toBe(new Date(-3_600_000).toLocaleString());
  });
});
