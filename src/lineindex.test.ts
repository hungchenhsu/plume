import { describe, expect, it } from "vitest";
import { clampLine, indexMatchesBaseline, selectCheckpoint } from "./lineindex";

describe("clampLine", () => {
  it("passes an in-range line through unchanged", () => {
    expect(clampLine(500, 5000)).toBe(500);
    expect(clampLine(0, 5000)).toBe(0);
  });

  it("clamps a target at or past totalLines to the last line", () => {
    expect(clampLine(5000, 5000)).toBe(4999);
    expect(clampLine(999_999, 5000)).toBe(4999);
  });

  it("clamps a negative target to 0", () => {
    expect(clampLine(-5, 5000)).toBe(0);
  });

  it("clamps to 0 for an empty index (0 total lines)", () => {
    expect(clampLine(10, 0)).toBe(0);
    expect(clampLine(0, 0)).toBe(0);
  });
});

describe("selectCheckpoint", () => {
  // 5 checkpoints 1024 lines apart, offsets matching the Rust
  // index_counts_lines_and_checkpoints_correctly fixture (13 bytes/line).
  const checkpoints = [0, 1024 * 13, 2048 * 13, 3072 * 13, 4096 * 13];

  it("selects checkpoint 0 for lines before the first interval", () => {
    expect(selectCheckpoint(checkpoints, 0)).toEqual({ line: 0, offset: 0 });
    expect(selectCheckpoint(checkpoints, 1023)).toEqual({ line: 0, offset: 0 });
  });

  it("selects the checkpoint exactly at an interval boundary", () => {
    expect(selectCheckpoint(checkpoints, 1024)).toEqual({
      line: 1024,
      offset: 1024 * 13,
    });
  });

  it("selects the largest checkpoint at or before an in-between line", () => {
    expect(selectCheckpoint(checkpoints, 1500)).toEqual({
      line: 1024,
      offset: 1024 * 13,
    });
    expect(selectCheckpoint(checkpoints, 4999)).toEqual({
      line: 4096,
      offset: 4096 * 13,
    });
  });

  it("clamps to the last checkpoint for a line past the last interval", () => {
    expect(selectCheckpoint(checkpoints, 999_999)).toEqual({
      line: 4096,
      offset: 4096 * 13,
    });
  });

  it("handles a single-checkpoint index", () => {
    expect(selectCheckpoint([0], 500)).toEqual({ line: 0, offset: 0 });
  });
});

// Issue #267: a freshly built index must only be adopted when it describes
// the same file version as the doc's own baseline — otherwise goto would
// display the new file's bytes while buffer/encoding/fingerprint still
// describe the old one, and continuation paging would immediately flag
// stale against doc.fingerprint.
describe("indexMatchesBaseline", () => {
  const fpA = { len: 100, modified: { secs: 1, nanos: 0 }, identity: [1, 2] };
  const fpB = { len: 200, modified: { secs: 2, nanos: 0 }, identity: [1, 3] };

  it("matches when both fingerprints describe the same version", () => {
    expect(indexMatchesBaseline(fpA, { ...fpA, identity: [1, 2] })).toBe(true);
  });

  it("rejects when the index was built from a different file version", () => {
    expect(indexMatchesBaseline(fpB, fpA)).toBe(false);
  });

  it("degrades to matching when either side has no fingerprint — a reload loop must be impossible", () => {
    expect(indexMatchesBaseline(null, fpA)).toBe(true);
    expect(indexMatchesBaseline(fpA, null)).toBe(true);
    expect(indexMatchesBaseline(undefined, undefined)).toBe(true);
  });
});
