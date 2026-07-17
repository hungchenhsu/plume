import { describe, expect, it } from "vitest";
import {
  clampSelectedIndex,
  filterAndSortCommands,
  fuzzyMatch,
  moveSelection,
} from "./palette";
import type { PaletteCommand } from "./ipc";

describe("fuzzyMatch", () => {
  it("matches an empty query against everything with score 0", () => {
    expect(fuzzyMatch("Save As…", "")).toEqual({ score: 0, indices: [] });
  });

  it("matches case-insensitively", () => {
    expect(fuzzyMatch("UPPERCASE", "upper")).not.toBeNull();
    expect(fuzzyMatch("lowercase", "LOWER")).not.toBeNull();
  });

  it("matches CJK label text", () => {
    expect(fuzzyMatch("儲存", "儲")).not.toBeNull();
    expect(fuzzyMatch("儲存", "存")).toEqual({ score: -1, indices: [1] });
  });

  it("returns null when query is not a subsequence of text", () => {
    expect(fuzzyMatch("Save", "xyz")).toBeNull();
    // Right letters, wrong order: 'v' would have to be found after 'e'.
    expect(fuzzyMatch("Save", "eva")).toBeNull();
  });

  it("returns the matched positions in text", () => {
    expect(fuzzyMatch("Save", "sa")).toEqual({ score: 1000, indices: [0, 1] });
  });

  it("scores a contiguous run higher than a scattered match of the same query", () => {
    const contiguous = fuzzyMatch("cat", "cat");
    const scattered = fuzzyMatch("coat", "cat");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });

  it("prefers an earlier match when consecutive-run counts are equal", () => {
    const early = fuzzyMatch("cat food", "cat");
    const late = fuzzyMatch("my cat", "cat");
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(early!.score).toBeGreaterThan(late!.score);
  });

  it("is greedy-leftmost, not a globally optimal alignment (documented simplification)", () => {
    // A DP-based optimal scorer would prefer the fully-contiguous "abc" at
    // the end (positions 2,3,4); greedy-leftmost claims the earliest 'a'
    // and 'b' (positions 0,1) first, forcing 'c' to match late and
    // non-consecutively. Pinning this documented trade-off rather than
    // hiding it.
    expect(fuzzyMatch("ababc", "abc")).toEqual({ score: 1000, indices: [0, 1, 4] });
  });
});

const COMMANDS: PaletteCommand[] = [
  { id: "save", label: "Save" },
  { id: "save_as", label: "Save As…" },
  { id: "find", label: "Find and Replace…" },
  { id: "sort_lines", label: "Sort Lines" },
];

describe("filterAndSortCommands", () => {
  it("returns everything for an empty query, in original order", () => {
    expect(filterAndSortCommands(COMMANDS, "").map((c) => c.id)).toEqual([
      "save",
      "save_as",
      "find",
      "sort_lines",
    ]);
  });

  it("filters to only fuzzy-matching labels", () => {
    expect(filterAndSortCommands(COMMANDS, "sort").map((c) => c.id)).toEqual(["sort_lines"]);
  });

  it("excludes commands whose label doesn't fuzzy-match at all", () => {
    expect(filterAndSortCommands(COMMANDS, "xyz")).toEqual([]);
  });

  it("carries the match info alongside id/label", () => {
    const [entry] = filterAndSortCommands(COMMANDS, "sort");
    expect(entry).toMatchObject({ id: "sort_lines", label: "Sort Lines" });
    expect(entry.match.indices).toEqual([0, 1, 2, 3]);
  });

  it("sorts matches by score, best first", () => {
    const commands: PaletteCommand[] = [
      { id: "b", label: "coat" },
      { id: "a", label: "cat" },
      { id: "c", label: "dog" },
    ];
    expect(filterAndSortCommands(commands, "cat").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps original relative order for equal scores (stable sort)", () => {
    const commands: PaletteCommand[] = [
      { id: "first", label: "Save" },
      { id: "second", label: "Save As…" },
    ];
    // Both greedy-leftmost-match "sa" at positions [0,1] -- genuinely tied
    // scores, so this pins the stable-sort tie-break rather than an actual
    // scoring difference.
    expect(filterAndSortCommands(commands, "sa").map((c) => c.id)).toEqual(["first", "second"]);
    const reversed: PaletteCommand[] = [commands[1], commands[0]];
    expect(filterAndSortCommands(reversed, "sa").map((c) => c.id)).toEqual(["second", "first"]);
  });
});

describe("moveSelection", () => {
  it("moves down within bounds", () => {
    expect(moveSelection(0, 1, 5)).toBe(1);
  });

  it("moves up within bounds", () => {
    expect(moveSelection(2, -1, 5)).toBe(1);
  });

  it("clamps at the bottom (no wraparound)", () => {
    expect(moveSelection(4, 1, 5)).toBe(4);
  });

  it("clamps at the top (no wraparound)", () => {
    expect(moveSelection(0, -1, 5)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(0, -1, 0)).toBe(0);
  });
});

describe("clampSelectedIndex", () => {
  it("leaves an in-range index unchanged", () => {
    expect(clampSelectedIndex(2, 5)).toBe(2);
  });

  it("clamps down to the new last index when the list shrinks", () => {
    expect(clampSelectedIndex(4, 2)).toBe(1);
  });

  it("clamps negative to 0", () => {
    expect(clampSelectedIndex(-1, 5)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(clampSelectedIndex(3, 0)).toBe(0);
  });
});
