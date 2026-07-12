import { describe, expect, it } from "vitest";
import {
  nextBookmark,
  previousBookmark,
  toggleBookmark,
  windowRelativeBookmarks,
} from "./bookmarks";

describe("toggleBookmark", () => {
  it("adds a line that isn't bookmarked yet, staying sorted", () => {
    expect(toggleBookmark([10, 30], 20)).toEqual([10, 20, 30]);
  });

  it("removes a line that is already bookmarked", () => {
    expect(toggleBookmark([10, 20, 30], 20)).toEqual([10, 30]);
  });

  it("adding to an empty list produces a single-element list", () => {
    expect(toggleBookmark([], 5)).toEqual([5]);
  });
});

describe("nextBookmark", () => {
  const bookmarks = [10, 30, 20]; // deliberately unsorted input

  it("finds the smallest bookmark strictly after current", () => {
    expect(nextBookmark(bookmarks, 15)).toBe(20);
  });

  it("wraps to the smallest bookmark once past the last one", () => {
    expect(nextBookmark(bookmarks, 30)).toBe(10);
    expect(nextBookmark(bookmarks, 999)).toBe(10);
  });

  it("returns the only bookmark repeatedly for a single-element list", () => {
    expect(nextBookmark([42], 42)).toBe(42);
  });

  it("returns null when there are no bookmarks", () => {
    expect(nextBookmark([], 0)).toBeNull();
  });
});

describe("previousBookmark", () => {
  const bookmarks = [10, 30, 20]; // deliberately unsorted input

  it("finds the largest bookmark strictly before current", () => {
    expect(previousBookmark(bookmarks, 25)).toBe(20);
  });

  it("wraps to the largest bookmark once before the first one", () => {
    expect(previousBookmark(bookmarks, 10)).toBe(30);
    expect(previousBookmark(bookmarks, 0)).toBe(30);
  });

  it("returns null when there are no bookmarks", () => {
    expect(previousBookmark([], 0)).toBeNull();
  });
});

describe("windowRelativeBookmarks", () => {
  it("returns an empty list when the window position is unknown", () => {
    expect(windowRelativeBookmarks([100, 200], null, 50)).toEqual([]);
  });

  it("maps absolute lines inside the window to buffer-relative lines", () => {
    // Window covers absolute lines 1000..1049 (50 lines starting at 1000).
    expect(windowRelativeBookmarks([999, 1000, 1025, 1049, 1050], 1000, 50)).toEqual([
      1, 26, 50,
    ]);
  });

  it("excludes bookmarks entirely outside the window", () => {
    expect(windowRelativeBookmarks([1, 5_000_000], 1000, 50)).toEqual([]);
  });
});
