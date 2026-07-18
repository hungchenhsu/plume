import { afterEach, describe, expect, it, vi } from "vitest";

const documentInfoSnapshot = vi.fn();
// vi.mock calls are hoisted above the static imports by vitest, so ./ipc
// is already mocked by the time ./docinfo is evaluated — same pattern as
// backup.test.ts. Only showDocumentInfo's own describe blocks below use
// this; every buildDocumentInfoDialogContent test feeds pre-resolved
// DocInfoFetch objects and never touches IPC.
vi.mock("./ipc", () => ({
  documentInfoSnapshot: (...a: unknown[]) =>
    (documentInfoSnapshot as (...x: unknown[]) => unknown)(...a),
}));

import {
  buildDocumentInfoDialogContent,
  formatDateTime,
  showDocumentInfo,
  type DocInfoFetch,
} from "./docinfo";
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
    dirty: false,
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

const okSnapshot = {
  metadata: { status: "ok" as const, data: { size: 2048, modifiedMs: 1_700_000_000_000 } },
  detection: { status: "ok" as const, data: cleanDetection },
  lineEnding: {
    status: "ok" as const,
    data: { lf: 10, crlf: 0, cr: 0, scannedBytes: 2048, totalSize: 2048 },
  },
};

// Issue #255: openDocument chose this document's encoding using the
// per-extension hint (main.ts's extensionHint), and detectcard.ts's Why
// Encoding? card forwards the same hint to explain_detection so the
// diagnostics describe the detection that actually ran. Document Info
// dropped the hint, silently re-running detection with different inputs —
// its evidence could then contradict the status bar's for the same file
// (spurious manual-override note, different would-choose verdict). These
// pin the caller-to-IPC contract — now a single documentInfoSnapshot call
// (issue #254) rather than three, but the hint-forwarding contract is
// unchanged.
describe("showDocumentInfo — documentInfoSnapshot hint contract (issue #255)", () => {
  function openInfo(extensionEncoding?: string): void {
    documentInfoSnapshot.mockResolvedValue(okSnapshot);
    showDocumentInfo({
      path: "/home/user/notes.txt",
      title: "notes.txt",
      encoding: "UTF-8",
      withBom: false,
      lineEnding: "LF",
      dirty: false,
      extensionEncoding,
      textStats: null,
    });
  }

  afterEach(async () => {
    // Let the snapshot promise settle, close the dialog (so the next
    // test's already-open guard doesn't trip), and drop the keydown
    // listener the dialog registered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.innerHTML = "";
    documentInfoSnapshot.mockReset();
  });

  it("forwards the caller's per-extension hint — the same one openDocument used", () => {
    openInfo("Big5");
    expect(documentInfoSnapshot).toHaveBeenCalledWith("/home/user/notes.txt", "Big5", "UTF-8");
  });

  it("passes no hint when the caller has none for this extension", () => {
    openInfo(undefined);
    expect(documentInfoSnapshot).toHaveBeenCalledWith(
      "/home/user/notes.txt",
      undefined,
      "UTF-8",
    );
  });
});

// Issue #254: documentInfoSnapshot bundles all three sections into one IPC
// round trip, so this module's adapter (sectionToFetch, and the inline
// mapping in showDocumentInfo) is now responsible for the per-section
// degrade the three-separate-calls design used to get for free from
// Promise.all. These drive the adapter end to end (through the rendered
// DOM, not just buildDocumentInfoDialogContent's pure mapping, which is
// already covered above) to prove it actually wires the Rust core's
// SectionOutcome shapes into the right per-section notes.
describe("showDocumentInfo — single-snapshot per-section degrade (issue #254)", () => {
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.innerHTML = "";
    documentInfoSnapshot.mockReset();
  });

  function notesText(): string[] {
    return Array.from(document.querySelectorAll(".docinfo-note")).map(
      (node) => node.textContent ?? "",
    );
  }

  it("shows only the encoding section's error note when detection alone fails", async () => {
    documentInfoSnapshot.mockResolvedValue({
      ...okSnapshot,
      detection: { status: "error", message: "sample read failed" },
    });
    showDocumentInfo({
      path: "/home/user/notes.txt",
      title: "notes.txt",
      encoding: "UTF-8",
      withBom: false,
      lineEnding: "LF",
      dirty: false,
      textStats: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notesText()).toEqual(["Couldn't load this information: sample read failed"]);
  });

  it("maps a skipped (UTF-16) line-ending section to the UTF-16 note, leaving other sections intact", async () => {
    documentInfoSnapshot.mockResolvedValue({
      ...okSnapshot,
      // wouldChoose agrees with the doc's own UTF-16LE encoding so the
      // encoding section's unrelated manual-override note (tested
      // separately above) doesn't also fire here.
      detection: { status: "ok", data: { ...cleanDetection, wouldChoose: "UTF-16LE (bom)" } },
      lineEnding: { status: "skipped", reason: "utf16" },
    });
    showDocumentInfo({
      path: "/home/user/notes.txt",
      title: "notes.txt",
      encoding: "UTF-16LE",
      withBom: false,
      lineEnding: "CRLF",
      dirty: false,
      textStats: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notesText()).toEqual(["Line-ending distribution isn't available for UTF-16 files."]);
  });

  it("shows an error note in all three sections when the snapshot call itself rejects", async () => {
    documentInfoSnapshot.mockRejectedValue(new Error("file gone"));
    showDocumentInfo({
      path: "/home/user/notes.txt",
      title: "notes.txt",
      encoding: "UTF-8",
      withBom: false,
      lineEnding: "LF",
      dirty: false,
      textStats: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notesText()).toEqual([
      "Couldn't load this information: Error: file gone",
      "Couldn't load this information: Error: file gone",
      "Couldn't load this information: Error: file gone",
    ]);
  });
});

// Issue #254 (framing facet): the dialog mixes live-buffer text stats with
// disk re-read facts. For a dirty document those describe different
// content, so a framing note must say which rows come from where; for a
// clean document (sources agree) and an untitled tab (no disk rows at
// all) the note must stay absent.
describe("buildDocumentInfoDialogContent — dirty disk-vs-buffer framing (issue #254)", () => {
  it("prefixes the file section with the framing note when the document is dirty", () => {
    const model = buildDocumentInfoDialogContent({ ...baseInput(), dirty: true });
    expect(model.fileSection.notes[0]).toContain("unsaved changes");
    // Issue #265: the note must put the encoding/line-ending *settings* on
    // the in-memory side of the split — setLineEnding / Save with Encoding
    // mutate doc state before any disk write, so those summary rows are
    // current state, not last-saved facts.
    expect(model.fileSection.notes[0]).toContain("current unsaved state");
    expect(model.fileSection.notes[0]).toContain("last saved version on disk");
  });

  it("control group: no note for a clean document", () => {
    const model = buildDocumentInfoDialogContent(baseInput());
    expect(model.fileSection.notes).toEqual([]);
  });

  it("no note for a dirty untitled tab — there are no disk rows to disagree with", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      dirty: true,
      path: null,
      title: "Untitled-1",
      metadata: { status: "skipped", reason: "untitled" },
      detection: { status: "skipped", reason: "untitled" },
      lineEndingDist: { status: "skipped", reason: "untitled" },
    });
    expect(model.fileSection.notes).toEqual([]);
  });

  it("keeps the note first even when a metadata load error adds its own note", () => {
    const model = buildDocumentInfoDialogContent({
      ...baseInput(),
      dirty: true,
      metadata: { status: "error", message: "gone" },
    });
    expect(model.fileSection.notes[0]).toContain("unsaved changes");
    expect(model.fileSection.notes[1]).toContain("gone");
  });
});
