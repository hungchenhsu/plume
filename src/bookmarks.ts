// Pure helpers for the Edit menu's Toggle/Next/Previous Bookmark commands
// (ROADMAP.md Track B, line-offset index). Line numbers are 1-based
// absolute file lines, matching every other user-facing line number in the
// app (goto.ts, editor.ts goToLine, the status-bar cursor position). Not
// persisted across sessions — see tabs.ts `Doc.bookmarks`.

/** Add `line` if absent, remove it if present. Result stays sorted
 *  ascending so Next/Previous can assume sorted input. */
export function toggleBookmark(bookmarks: readonly number[], line: number): number[] {
  if (bookmarks.includes(line)) {
    return bookmarks.filter((existing) => existing !== line);
  }
  return [...bookmarks, line].sort((a, b) => a - b);
}

/** Smallest bookmark strictly after `current`, wrapping to the smallest
 *  bookmark overall once past the last one. Null when `bookmarks` is
 *  empty. */
export function nextBookmark(bookmarks: readonly number[], current: number): number | null {
  if (bookmarks.length === 0) return null;
  const sorted = [...bookmarks].sort((a, b) => a - b);
  return sorted.find((line) => line > current) ?? sorted[0];
}

/** Largest bookmark strictly before `current`, wrapping to the largest
 *  bookmark overall once before the first one. Null when `bookmarks` is
 *  empty. */
export function previousBookmark(bookmarks: readonly number[], current: number): number | null {
  if (bookmarks.length === 0) return null;
  const sorted = [...bookmarks].sort((a, b) => b - a);
  return sorted.find((line) => line < current) ?? sorted[0];
}

/**
 * Bookmarks that fall inside the currently loaded large-file window,
 * converted to buffer-relative (1-based) line numbers for the editor
 * gutter. `windowStartLine` is the absolute (1-based) line number of the
 * window's own first line; null means the window's absolute position isn't
 * currently known (see tabs.ts `Doc.windowStartLine`), in which case
 * nothing can be safely mapped and this returns an empty list.
 */
export function windowRelativeBookmarks(
  bookmarks: readonly number[],
  windowStartLine: number | null,
  windowLineCount: number,
): number[] {
  if (windowStartLine === null) return [];
  const windowEndLine = windowStartLine + windowLineCount - 1;
  return bookmarks
    .filter((line) => line >= windowStartLine && line <= windowEndLine)
    .map((line) => line - windowStartLine + 1);
}
