import { describe, expect, it } from "vitest";
import { hexPreviewCaption } from "./hexview";

describe("hexPreviewCaption", () => {
  it("reports a truncated preview as 'first N of M'", () => {
    expect(hexPreviewCaption(64 * 1024, 200 * 1024)).toBe(
      "showing first 64 KB of 200 KB",
    );
  });

  it("reports a fully shown file without the 'of' clause", () => {
    expect(hexPreviewCaption(500, 500)).toBe("showing all 1 KB");
  });

  it("treats shownBytes exceeding totalSize as fully shown (defensive)", () => {
    expect(hexPreviewCaption(1024, 500)).toBe("showing all 1 KB");
  });

  it("formats an empty file", () => {
    expect(hexPreviewCaption(0, 0)).toBe("showing all 1 KB");
  });
});
