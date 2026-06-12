import { describe, expect, it } from "vitest";
import {
  canAutoAppend,
  MAX_AUTO_CHUNKS,
  nearEnd,
  NEAR_END_MARGIN,
} from "./chunkpolicy";

describe("nearEnd", () => {
  it("fires within the margin of the document end", () => {
    expect(nearEnd(10_000, 10_000)).toBe(true);
    expect(nearEnd(10_000 - NEAR_END_MARGIN, 10_000)).toBe(true);
    expect(nearEnd(10_000 - NEAR_END_MARGIN - 1, 10_000)).toBe(false);
  });
});

describe("canAutoAppend", () => {
  const base = { loadedChunks: 1, nextOffset: 2048 as number | null, inFlight: false };

  it("allows appending in the normal case", () => {
    expect(canAutoAppend(base)).toBe(true);
  });

  it("blocks while a load is in flight", () => {
    expect(canAutoAppend({ ...base, inFlight: true })).toBe(false);
  });

  it("blocks at end of file", () => {
    expect(canAutoAppend({ ...base, nextOffset: null })).toBe(false);
  });

  it("blocks at the window cap", () => {
    expect(canAutoAppend({ ...base, loadedChunks: MAX_AUTO_CHUNKS })).toBe(
      false,
    );
  });
});
