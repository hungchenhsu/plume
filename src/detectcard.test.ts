import { describe, expect, it } from "vitest";
import { formatDetectionCard, parseWouldChoose } from "./detectcard";
import type { DetectionExplanation } from "./ipc";

describe("parseWouldChoose", () => {
  it("splits the encoding from a bom reason", () => {
    expect(parseWouldChoose("UTF-8 (bom)")).toEqual({
      encoding: "UTF-8",
      reason: "bom",
    });
  });

  it("splits the encoding from a detector reason", () => {
    expect(parseWouldChoose("Big5 (detector)")).toEqual({
      encoding: "Big5",
      reason: "detector",
    });
  });

  it("splits the encoding from a fallback reason", () => {
    expect(parseWouldChoose("UTF-8 (fallback)")).toEqual({
      encoding: "UTF-8",
      reason: "fallback",
    });
  });

  it("falls back to treating the whole string as the encoding when unrecognized", () => {
    expect(parseWouldChoose("UTF-8")).toEqual({
      encoding: "UTF-8",
      reason: "detector",
    });
  });
});

describe("formatDetectionCard", () => {
  const bomInfo: DetectionExplanation = {
    bom: "UTF-8 BOM (EF BB BF)",
    detectorVerdict: "UTF-8",
    sampledBytes: 5,
    totalSize: 5,
    wouldChoose: "UTF-8 (bom)",
  };

  it("titles the card after the currently-used encoding", () => {
    const model = formatDetectionCard("readme.txt", "UTF-8", bomInfo);
    expect(model.title).toBe("Why UTF-8?");
  });

  it("reports BOM, verdict and sample size as rows", () => {
    const model = formatDetectionCard("readme.txt", "UTF-8", bomInfo);
    expect(model.rows).toContainEqual({ label: "File", value: "readme.txt" });
    expect(model.rows).toContainEqual({
      label: "BOM",
      value: "UTF-8 BOM (EF BB BF)",
    });
    expect(model.rows).toContainEqual({
      label: "chardetng verdict",
      value: "UTF-8",
    });
    expect(model.rows).toContainEqual({
      label: "Sampled",
      value: "all 1 KB",
    });
    expect(model.rows).toContainEqual({
      label: "Auto-detect would choose",
      value: "UTF-8 (a BOM was found)",
    });
    expect(model.rows).toContainEqual({
      label: "Currently using",
      value: "UTF-8",
    });
  });

  it("reports 'No BOM found' when there is no BOM", () => {
    const info: DetectionExplanation = {
      bom: null,
      detectorVerdict: "Big5",
      sampledBytes: 128,
      totalSize: 128,
      wouldChoose: "Big5 (detector)",
    };
    const model = formatDetectionCard("notes.txt", "Big5", info);
    expect(model.rows).toContainEqual({
      label: "BOM",
      value: "No BOM found",
    });
  });

  it("shows a truncated sample as 'first N of M'", () => {
    const info: DetectionExplanation = {
      bom: null,
      detectorVerdict: "windows-1252",
      sampledBytes: 64 * 1024,
      totalSize: 200 * 1024,
      wouldChoose: "windows-1252 (detector)",
    };
    const model = formatDetectionCard("big.log", "windows-1252", info);
    expect(model.rows).toContainEqual({
      label: "Sampled",
      value: "first 64 KB of 200 KB",
    });
  });

  it("has no manual note when the current encoding matches auto-detect", () => {
    const model = formatDetectionCard("readme.txt", "UTF-8", bomInfo);
    expect(model.manualNote).toBeNull();
  });

  it("notes a manual override when the current encoding differs from auto-detect", () => {
    const model = formatDetectionCard("readme.txt", "Big5", bomInfo);
    expect(model.manualNote).toBe(
      "Currently using Big5 manually — auto-detect would choose UTF-8.",
    );
  });
});
