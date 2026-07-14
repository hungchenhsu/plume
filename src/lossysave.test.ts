import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import type { LossyReport } from "./ipc";
import { buildLossySaveDialogContent } from "./lossysave";

// Every test that calls setLocale must restore the default so later tests
// (and other test files sharing this module instance) see English again —
// mirrors i18n.test.ts's own convention.
afterEach(() => {
  setLocale("en");
});

const oneSample: LossyReport = {
  unmappableCount: 1,
  samples: [{ display: "é (U+00E9)", line: 3, column: 14 }],
  samplesTruncated: false,
};

describe("buildLossySaveDialogContent", () => {
  it("names the encoding and total occurrence count in the summary", () => {
    const content = buildLossySaveDialogContent("Big5", oneSample);
    expect(content.title).toBe("Encoding warning");
    expect(content.summary).toBe(
      "1 character can't be represented in Big5. Continuing to save will write " +
        "replacement characters in their place, and this can't be undone.",
    );
  });

  it("pluralizes the count when more than one character is unmappable", () => {
    const content = buildLossySaveDialogContent("Big5", {
      ...oneSample,
      unmappableCount: 3,
    });
    expect(content.summary).toContain("3 characters can't be represented in Big5.");
  });

  it("formats one line per sample with its display text and 1-based position", () => {
    const content = buildLossySaveDialogContent("Big5", oneSample);
    expect(content.sampleLines).toEqual(["é (U+00E9) — Ln 3, Col 14"]);
  });

  it("formats multiple samples in the given order", () => {
    const report: LossyReport = {
      unmappableCount: 2,
      samples: [
        { display: "é (U+00E9)", line: 1, column: 1 },
        { display: "🚀 (U+1F680)", line: 2, column: 5 },
      ],
      samplesTruncated: false,
    };
    const content = buildLossySaveDialogContent("Big5", report);
    expect(content.sampleLines).toEqual([
      "é (U+00E9) — Ln 1, Col 1",
      "🚀 (U+1F680) — Ln 2, Col 5",
    ]);
  });

  it("has no truncation note when samplesTruncated is false", () => {
    const content = buildLossySaveDialogContent("Big5", oneSample);
    expect(content.truncatedNote).toBeNull();
  });

  it("appends a truncation note when samplesTruncated is true", () => {
    const content = buildLossySaveDialogContent("Big5", {
      ...oneSample,
      samplesTruncated: true,
    });
    expect(content.truncatedNote).toBe("More distinct characters exist beyond this list.");
  });

  it("produces an empty sample-line list when there are no samples", () => {
    const content = buildLossySaveDialogContent("Big5", {
      unmappableCount: 0,
      samples: [],
      samplesTruncated: false,
    });
    expect(content.sampleLines).toEqual([]);
    expect(content.truncatedNote).toBeNull();
  });

  it("localizes the summary and sample-line phrasing (zh-TW)", () => {
    setLocale("zh-TW");
    const content = buildLossySaveDialogContent("Big5", oneSample);
    expect(content.title).toBe("編碼警告");
    expect(content.summary).toBe(
      "有 1 個字元無法以 Big5 表示，繼續儲存將以替代字元寫入且無法復原。",
    );
    expect(content.sampleLines).toEqual(["é (U+00E9) — 第 3 行，第 14 欄"]);
  });
});
