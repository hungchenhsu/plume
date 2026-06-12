import { describe, expect, it } from "vitest";
import {
  canAutoAppend,
  canPrepend,
  nearEnd,
  nearStart,
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
  const base = { nextOffset: 2048 as number | null, inFlight: false };

  it("allows appending in the normal case", () => {
    expect(canAutoAppend(base)).toBe(true);
  });

  it("blocks while a load is in flight", () => {
    expect(canAutoAppend({ ...base, inFlight: true })).toBe(false);
  });

  it("blocks at end of file", () => {
    expect(canAutoAppend({ ...base, nextOffset: null })).toBe(false);
  });
});

describe("nearStart", () => {
  it("fires within the margin of the document start", () => {
    expect(nearStart(0)).toBe(true);
    expect(nearStart(NEAR_END_MARGIN)).toBe(true);
    expect(nearStart(NEAR_END_MARGIN + 1)).toBe(false);
  });
});

describe("canPrepend", () => {
  const base = { windowStart: 4096, inFlight: false };

  it("allows prepending mid-file", () => {
    expect(canPrepend(base)).toBe(true);
  });

  it("blocks at the start of the file", () => {
    expect(canPrepend({ ...base, windowStart: 0 })).toBe(false);
  });

  it("blocks while a load is in flight", () => {
    expect(canPrepend({ ...base, inFlight: true })).toBe(false);
  });
});
