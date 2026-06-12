import { describe, expect, it } from "vitest";
import { formatSize } from "./statusbar";

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
