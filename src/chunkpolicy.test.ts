import { describe, expect, it } from "vitest";
import {
  canAutoAppend,
  canPrepend,
  nearEnd,
  nearStart,
  NEAR_END_MARGIN,
  pagingSupported,
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

describe("pagingSupported", () => {
  it("allows paging for a truncated document with an ordinary encoding", () => {
    expect(pagingSupported({ truncated: true, encoding: "UTF-8" })).toBe(true);
    expect(pagingSupported({ truncated: true, encoding: "Big5" })).toBe(true);
  });

  it("blocks paging for a non-truncated document regardless of encoding", () => {
    expect(pagingSupported({ truncated: false, encoding: "UTF-8" })).toBe(false);
  });

  it("blocks paging for UTF-16 chunks, which cannot be line-aligned", () => {
    expect(pagingSupported({ truncated: true, encoding: "UTF-16LE" })).toBe(false);
    expect(pagingSupported({ truncated: true, encoding: "UTF-16BE" })).toBe(false);
  });

  /** Issue #225: ISO-2022-JP is the one encoding_rs encoding whose decoder
   *  is genuinely stateful. Each chunk-paging request decodes with a brand
   *  new decoder that has no memory of the previous page's JIS shift
   *  state, so a raw cut landing inside a shift sequence lets the
   *  following page silently misdecode well-formed-looking-but-wrong text
   *  with no malformed signal. Paging must be disabled for it exactly like
   *  UTF-16 above (chunk.rs rejects it at the command layer too). */
  it("blocks paging for ISO-2022-JP, whose decoder is stateful across chunks", () => {
    expect(pagingSupported({ truncated: true, encoding: "ISO-2022-JP" })).toBe(false);
  });
});
