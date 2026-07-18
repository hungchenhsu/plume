// Pure helpers for the large-file line-offset index (see
// src-tauri/src/lineindex.rs and the `LineIndex` type in ipc.ts). Line
// numbers in this module are 0-based, mirroring `LineIndex.checkpoints`
// (`checkpoints[k]` is the byte offset of line `k * CHECKPOINT_INTERVAL`,
// 0-based) — main.ts converts to/from the 1-based line numbers used
// everywhere else in the UI (goto.ts, editor.ts goToLine, doc.bookmarks) at
// the boundary where it calls into this module.

/** Mirrors src-tauri/src/lineindex.rs CHECKPOINT_INTERVAL. */
export const CHECKPOINT_INTERVAL = 1024;

import { fingerprintsEqual } from "./savemutex";

/**
 * Whether a freshly built index (fingerprinted at build time,
 * `LineIndex.fingerprint`) still describes the same file version as the
 * doc's own baseline (`Doc.fingerprint`, captured at open/reload). False
 * means the file was replaced under a missed watcher event while the doc
 * was open — adopting the index anyway would mix two file versions in one
 * Doc (issue #267); the caller must route through the external-change
 * reload flow first. Either side missing (`null`/`undefined` — a
 * filesystem where the fingerprint couldn't be captured) compares as
 * matching: there is nothing to validate against, and degrading to the
 * pre-#267 behavior beats a reload loop that could never terminate.
 */
export function indexMatchesBaseline(
  reportFingerprint: unknown,
  docFingerprint: unknown,
): boolean {
  if (reportFingerprint == null || docFingerprint == null) return true;
  return fingerprintsEqual(reportFingerprint, docFingerprint);
}

/**
 * Clamp a requested 0-based target line into the valid range for an index
 * reporting `totalLines` lines. `totalLines <= 0` (an empty file has no
 * lines at all) clamps to 0 — callers with nothing to jump to should check
 * `totalLines` themselves before acting on the result.
 */
export function clampLine(targetLine: number, totalLines: number): number {
  if (totalLines <= 0) return 0;
  return Math.max(0, Math.min(targetLine, totalLines - 1));
}

/**
 * Pick the checkpoint at or before `targetLine` (both 0-based), returning
 * that checkpoint's own line number and byte offset. Assumes `checkpoints`
 * is non-empty — `build_line_index` only ever returns an empty array for a
 * 0-byte file, which large-file mode never opens (files that small are
 * never truncated in the first place).
 */
export function selectCheckpoint(
  checkpoints: readonly number[],
  targetLine: number,
): { line: number; offset: number } {
  const index = Math.min(
    Math.floor(targetLine / CHECKPOINT_INTERVAL),
    checkpoints.length - 1,
  );
  return { line: index * CHECKPOINT_INTERVAL, offset: checkpoints[index] };
}
