// Pure logic for the replace-in-files preview/confirm/result flow layered
// on top of the find-in-files panel (ROADMAP.md v0.5 Track S, frontend
// item; backend: src-tauri/src/replaceinfiles.rs + ipc.ts's
// scanReplaceInFolder/executeReplaceInFolder). Kept separate from
// findinfiles.ts's DOM wiring so the destructive-confirm wording and
// per-file classification — the actual risk surface of this feature, since
// it rewrites multiple files on disk with no undo — are unit-testable
// without a DOM, mirroring how lossysave.ts/bytedrift.ts/comparepreview.ts
// each carry their own panel's pure decision logic apart from the DOM code
// that renders it.
//
// Scope: a file's own on-disk fingerprint continuity, encoding, and lossy
// prediction are entirely decided by src-tauri/src/replaceinfiles.rs — this
// module only classifies/labels/formats what the Rust side already
// reported (ipc.ts's ReplaceScanEntry / ReplaceExecuteEntry), never
// re-derives them.
import { t } from "./i18n";
import type { ReplaceExecuteEntry, ReplaceExecuteTarget, ReplaceScanEntry } from "./ipc";

// ---------------------------------------------------------------------------
// Skip-reason labeling (preview rows)
// ---------------------------------------------------------------------------

/** The exact, constant `skippedReason` strings `replaceinfiles.rs`'s
 *  `scan_one_file` reports for its two non-dynamic skip causes (see its
 *  `skipped_entry` call sites) — matched by exact equality so a future
 *  wording tweak on the Rust side fails safe into the generic `ioError`
 *  bucket below rather than silently mis-categorizing. The third cause,
 *  `format!("Failed to read: {e}")`, is inherently dynamic (it embeds the
 *  OS error) and is never pattern-matched here — anything that isn't one of
 *  these two known constants falls into the `ioError` label. */
const OVERSIZED_REASON = "File exceeds the 5 MiB search cap";
const MALFORMED_REASON =
  "File does not decode cleanly under detection; skipped, not searched";

/**
 * Localized, human-readable label for a `ReplaceScanEntry.skippedReason`
 * string — never shows the raw Rust/OS text as the primary label (the
 * task's i18n requirement for skip reasons). Callers may still surface the
 * raw `reason` separately (e.g. as a tooltip) for power-user diagnosis —
 * see `ReplacePreviewRow.skipTitle`.
 */
export function skipReasonLabel(reason: string): string {
  if (reason === OVERSIZED_REASON) return t("findInFiles.skipReasonOversized");
  if (reason === MALFORMED_REASON) return t("findInFiles.skipReasonMalformed");
  return t("findInFiles.skipReasonIoError");
}

// ---------------------------------------------------------------------------
// Preview row assembly
// ---------------------------------------------------------------------------

export interface ReplacePreviewRow {
  path: string;
  matchCountLabel: string;
  /** Detected encoding name, e.g. "Big5" — raw, never localized (matches
   *  every other encoding-name display in this app: detectcard.ts,
   *  statusbar.ts, batchconvert.ts all show it verbatim). Empty when
   *  `!selectable` and the file was never even opened (too large). */
  encoding: string;
  lossy: boolean;
  /** False for a skipped entry — never checkable, never sent to execute. */
  selectable: boolean;
  /** Localized skip reason, `null` when `selectable`. */
  skipLabel: string | null;
  /** Raw backend reason, `null` when `selectable` — for a tooltip only;
   *  never rendered as the row's primary text (see `skipReasonLabel`). */
  skipTitle: string | null;
}

/**
 * Pure helper: dry-run scan entries -> display-ready preview rows, in
 * report order. DOM-free (no basename shortening, no element creation) so
 * the row data — the exact thing a user reviews before a destructive,
 * unrecoverable multi-file write — is testable without jsdom.
 */
export function buildPreviewRows(entries: ReplaceScanEntry[]): ReplacePreviewRow[] {
  return entries.map((entry) => {
    const matchCountLabel = t("findInFiles.replaceMatchCount", entry.matchCount);
    if (entry.skippedReason !== null) {
      return {
        path: entry.path,
        matchCountLabel,
        encoding: entry.encoding,
        lossy: entry.lossy,
        selectable: false,
        skipLabel: skipReasonLabel(entry.skippedReason),
        skipTitle: entry.skippedReason,
      };
    }
    return {
      path: entry.path,
      matchCountLabel,
      encoding: entry.encoding,
      lossy: entry.lossy,
      selectable: true,
      skipLabel: null,
      skipTitle: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Report-wide and selection-wide totals
// ---------------------------------------------------------------------------

export interface PreviewTotals {
  fileCount: number;
  matchCount: number;
  skippedCount: number;
}

/** Pure helper: the report-wide breakdown for the always-visible preview
 *  summary line, independent of any checkbox state. */
export function previewTotals(entries: ReplaceScanEntry[]): PreviewTotals {
  let fileCount = 0;
  let matchCount = 0;
  let skippedCount = 0;
  for (const entry of entries) {
    if (entry.skippedReason !== null) {
      skippedCount += 1;
      continue;
    }
    fileCount += 1;
    matchCount += entry.matchCount;
  }
  return { fileCount, matchCount, skippedCount };
}

/** Entries still selected for execute — every non-skipped entry except
 *  those in `uncheckedPaths`. Mirrors batchconvert.ts's
 *  `selectedConvertiblePaths`: a skipped entry is never selectable
 *  regardless of `uncheckedPaths`' contents (it was never checkable in the
 *  first place), and a stale path in `uncheckedPaths` that doesn't match
 *  any entry is silently ignored. Not exported — `selectionTotals` and
 *  `selectedReplaceTargets` are the two public views over this same
 *  filtered set, kept as one implementation so they can never disagree
 *  about which entries count as "selected". */
function selectedEntries(
  entries: ReplaceScanEntry[],
  uncheckedPaths: ReadonlySet<string>,
): ReplaceScanEntry[] {
  return entries.filter(
    (entry) => entry.skippedReason === null && !uncheckedPaths.has(entry.path),
  );
}

export interface SelectionTotals {
  fileCount: number;
  matchCount: number;
  lossyFileCount: number;
}

/** Pure helper: totals over exactly the checked subset — this is what the
 *  confirm dialog and the execute button's count must describe, never the
 *  full report's totals (see `previewTotals`). */
export function selectionTotals(
  entries: ReplaceScanEntry[],
  uncheckedPaths: ReadonlySet<string>,
): SelectionTotals {
  const selected = selectedEntries(entries, uncheckedPaths);
  let matchCount = 0;
  let lossyFileCount = 0;
  for (const entry of selected) {
    matchCount += entry.matchCount;
    if (entry.lossy) lossyFileCount += 1;
  }
  return { fileCount: selected.length, matchCount, lossyFileCount };
}

// ---------------------------------------------------------------------------
// Selection -> execute() parameters
// ---------------------------------------------------------------------------

/**
 * Pure helper: the checked subset, converted to exactly what
 * `executeReplaceInFolder` needs — a skipped entry can never appear here
 * even if it were somehow present (or absent) from `uncheckedPaths`, since
 * it was never checkable to begin with (see `selectedEntries`). Each
 * target's `expectedFingerprint` is the scan-time snapshot passed through
 * unchanged (including `null`) — never re-derived here, since only
 * execute_one's own fresh stat is allowed to decide continuity.
 */
export function selectedReplaceTargets(
  entries: ReplaceScanEntry[],
  uncheckedPaths: ReadonlySet<string>,
): ReplaceExecuteTarget[] {
  return selectedEntries(entries, uncheckedPaths).map((entry) => ({
    path: entry.path,
    expectedFingerprint: entry.fingerprint,
  }));
}

// ---------------------------------------------------------------------------
// Destructive confirm message
// ---------------------------------------------------------------------------

/**
 * Pure helper: the batch-convert-strength confirm dialog's message.
 * `lossyFileCount` (from `selectionTotals`, over the checked subset only)
 * gates a second clause that must never be glossed over — a file whose
 * replacement can't be represented in its own encoding is not rejected, it
 * is written anyway with the unmappable character substituted as a literal
 * HTML numeric character reference (`&#NNNN;`) by `encoding_rs`'s encoder
 * (see `src-tauri/src/streamcodec.rs`'s `encode_chunk` doc comment) — the
 * exact semantics ROADMAP.md's Track S entry flagged as needing to be
 * "spelled out in the panel's confirm wording". `lossyFileCount === 0`
 * omits the clause entirely rather than mentioning it vacuously.
 */
export function buildReplaceConfirmMessage(
  fileCount: number,
  matchCount: number,
  lossyFileCount: number,
): string {
  return lossyFileCount > 0
    ? t("findInFiles.replaceConfirmMessageLossy", fileCount, matchCount, lossyFileCount)
    : t("findInFiles.replaceConfirmMessage", fileCount, matchCount);
}

// ---------------------------------------------------------------------------
// Post-execute result summary
// ---------------------------------------------------------------------------

/** Every non-"ok" status `execute_replace_in_folder` can report (see
 *  ipc.ts's `ReplaceExecuteEntry.status` doc comment), in the fixed order
 *  their groups are shown when present. `summarizeReplaceResults` still
 *  surfaces any status outside this list (defense in depth — an
 *  unrecognized status must never silently vanish from the summary), just
 *  without a guaranteed position in the ordering. */
const FAILURE_STATUSES = [
  "changed_since_scan",
  "lossy_blocked",
  "io_error",
  "decode_error",
  "too_large",
] as const;

function failureLabel(status: string): string {
  switch (status) {
    case "changed_since_scan":
      return t("findInFiles.replaceStatusChangedSinceScan");
    case "lossy_blocked":
      return t("findInFiles.replaceStatusLossyBlocked");
    case "io_error":
      return t("findInFiles.replaceStatusIoError");
    case "decode_error":
      return t("findInFiles.replaceStatusDecodeError");
    case "too_large":
      return t("findInFiles.replaceStatusTooLarge");
    default:
      // Defense in depth only (mirrors batchconvert.ts's statusLabel
      // default case): execute_one only ever returns one of
      // FAILURE_STATUSES or "ok". An unrecognized status still gets a
      // group of its own in summarizeReplaceResults rather than being
      // silently dropped — this app's standing rule that a failure must
      // always surface to the user, applied to a status this frontend
      // doesn't yet know the name for.
      return status;
  }
}

export interface ReplaceResultGroup {
  status: string;
  label: string;
  entries: ReplaceExecuteEntry[];
}

export interface ReplaceResultSummary {
  okCount: number;
  totalReplacements: number;
  failedGroups: ReplaceResultGroup[];
}

/**
 * Pure helper: classify `executeReplaceInFolder`'s flat result array into
 * the success tally plus one labeled group per failure status actually
 * present — in `FAILURE_STATUSES` order, empty groups omitted, and
 * (defensively) any status this module doesn't recognize still surfaced in
 * its own group, in first-seen order after the known ones, rather than
 * silently dropped.
 */
export function summarizeReplaceResults(results: ReplaceExecuteEntry[]): ReplaceResultSummary {
  const okEntries = results.filter((r) => r.status === "ok");
  const totalReplacements = okEntries.reduce((sum, r) => sum + r.replacedCount, 0);

  const statusOrder: string[] = [...FAILURE_STATUSES];
  for (const r of results) {
    if (r.status !== "ok" && !statusOrder.includes(r.status)) {
      statusOrder.push(r.status);
    }
  }

  const failedGroups: ReplaceResultGroup[] = [];
  for (const status of statusOrder) {
    const entries = results.filter((r) => r.status === status);
    if (entries.length > 0) {
      failedGroups.push({ status, label: failureLabel(status), entries });
    }
  }

  return { okCount: okEntries.length, totalReplacements, failedGroups };
}
