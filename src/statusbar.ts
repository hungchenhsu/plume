import type { DocumentTextStats } from "./editor";
import { t } from "./i18n";

interface StatusInfo {
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
  truncated: boolean;
  /** User-toggled per-tab read-only lock (ROADMAP.md v0.4 Track C),
   *  independent of `truncated` — see tabs.ts's `isEffectivelyReadOnly`. */
  userReadOnly: boolean;
  totalSize: number;
}

const pathEl = document.querySelector<HTMLElement>("#status-path")!;
const encodingEl = document.querySelector<HTMLElement>("#status-encoding")!;
const lineEndingEl = document.querySelector<HTMLElement>(
  "#status-line-ending",
)!;
const warningEl = document.querySelector<HTMLElement>("#status-warning")!;
const readonlyEl = document.querySelector<HTMLElement>("#status-readonly")!;
const indexingEl = document.querySelector<HTMLElement>("#status-indexing")!;
const cursorEl = document.querySelector<HTMLElement>("#status-cursor")!;
const charInspectorEl = document.querySelector<HTMLButtonElement>(
  "#status-char-inspector",
)!;
const textStatsEl = document.querySelector<HTMLElement>("#status-textstats")!;
const suspiciousCharsEl = document.querySelector<HTMLElement>("#status-suspicious")!;
const chunkPrevEl = document.querySelector<HTMLButtonElement>("#chunk-prev")!;
const chunkNextEl = document.querySelector<HTMLButtonElement>("#chunk-next")!;

// The decode-warning button's label never changes with document state (only
// its visibility does, via `updateStatusBar`), so it only needs a refresh
// when the locale changes. See main.ts's onLocaleChange subscription.
export function applyStaticLabels(): void {
  warningEl.textContent = t("statusbar.decodeWarning");
}

let lastCursor: { line: number; column: number } = { line: 1, column: 1 };

export function updateCursor(line: number, column: number): void {
  lastCursor = { line, column };
  cursorEl.textContent = t("statusbar.cursor", line, column);
}

/** Re-render the cursor label after a locale change, using the last known
 *  position (the editor doesn't need to re-report it). */
export function refreshCursor(): void {
  updateCursor(lastCursor.line, lastCursor.column);
}

/** The active buffer's current 1-based cursor line, as last reported by the
 *  editor's `onCursorMoved` callback (see main.ts's `createEditor` wiring).
 *  Used by main.ts's bookmark commands to find "the current line" without
 *  reaching into CodeMirror internals directly. */
export function currentCursorLine(): number {
  return lastCursor.line;
}

/** "U+XXXX" for a single Unicode code point: uppercase hex, zero-padded to
 *  at least 4 digits (a supplementary character like U+1F600 naturally
 *  takes 5). Shared by the status-bar segment below and charinspect.ts's
 *  popup, mirroring `formatSize` below being reused by detectcard.ts. */
export function formatCodePoint(char: string): string {
  const codePoint = char.codePointAt(0)!;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

let lastChar: string | null = null;

/** Update (or hide) the character-inspector status-bar segment (ROADMAP.md
 *  v0.4 Track A). Pass `null` to hide it — no active document, an empty
 *  document, or the cursor at a line start (see editor.ts's
 *  `characterBeforeCursor` for the exact semantics main.ts's
 *  `onCursorMoved` computes this from). Works the same in a large-file
 *  (truncated) window: the character at the cursor is meaningful within
 *  whatever window is loaded, unlike whole-document text stats. */
export function updateCharInspector(char: string | null): void {
  lastChar = char;
  charInspectorEl.hidden = char === null;
  charInspectorEl.textContent =
    char === null ? "" : t("statusbar.charInspector", char, formatCodePoint(char));
}

/** Re-render the character-inspector segment after a locale change, using
 *  the last known character (no recomputation needed). */
export function refreshCharInspector(): void {
  updateCharInspector(lastChar);
}

/** The character currently shown in the inspector segment, if any — used
 *  by main.ts's click handler to open the byte-sequence popup without
 *  recomputing from the editor (see charinspect.ts `showCharInspector`). */
export function currentInspectedChar(): string | null {
  return lastChar;
}

let lastTextStats: DocumentTextStats | null = null;

/** Update (or hide) the word/char/line count segment (ROADMAP.md v0.4
 *  Track C). Pass `null` to hide it entirely — no active document, or a
 *  large-file (truncated) window, where stats over just the loaded window
 *  would misrepresent the whole file (see main.ts's call sites). */
export function updateTextStats(result: DocumentTextStats | null): void {
  lastTextStats = result;
  textStatsEl.hidden = result === null;
  if (result === null) {
    textStatsEl.textContent = "";
    return;
  }
  const { chars, words, lines } = result.stats;
  textStatsEl.textContent = result.selected
    ? t("statusbar.textStatsSelection", words, chars, lines)
    : t("statusbar.textStats", words, chars, lines);
}

/** Re-render the text-stats segment after a locale change, using the last
 *  known result (no recomputation needed). */
export function refreshTextStats(): void {
  updateTextStats(lastTextStats);
}

let lastSuspiciousCount: number | null = null;

/** Update (or hide) the suspicious/invisible character audit count segment
 *  (ROADMAP.md v0.4 Track A). Pass `null` to hide it — no active document,
 *  a large-file (truncated) window (same "would misrepresent the whole
 *  file" reasoning `updateTextStats` uses above, see main.ts
 *  `computeAndShowSuspiciousChars`), or a count of exactly 0 (nothing
 *  suspicious to report, so the segment stays out of the way). Unlike
 *  `updateTextStats`, this is never gated by the View-menu highlight
 *  toggle — see `setSuspiciousChars`'s doc comment in editor.ts. */
export function updateSuspiciousChars(count: number | null): void {
  lastSuspiciousCount = count;
  const hidden = count === null || count === 0;
  suspiciousCharsEl.hidden = hidden;
  suspiciousCharsEl.textContent = hidden ? "" : t("statusbar.suspiciousChars", count);
}

/** Re-render the suspicious-char segment after a locale change, using the
 *  last known count (no recomputation needed). */
export function refreshSuspiciousChars(): void {
  updateSuspiciousChars(lastSuspiciousCount);
}

/** Show/hide the "building line index…" status-bar hint (large-file
 *  go-to-line/bookmarks — see main.ts `ensureLineIndex`). */
export function setIndexing(active: boolean): void {
  indexingEl.hidden = !active;
  if (active) indexingEl.textContent = t("statusbar.buildingIndex");
}

/** Show/hide the large-file pager buttons. Pass null to hide both. */
export function updatePager(
  state: { hasPrev: boolean; hasNext: boolean } | null,
): void {
  chunkPrevEl.hidden = state === null;
  chunkNextEl.hidden = state === null;
  chunkPrevEl.disabled = !state?.hasPrev;
  chunkNextEl.disabled = !state?.hasNext;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let lastDoc: StatusInfo | null = null;

export function updateStatusBar(doc: StatusInfo | null): void {
  lastDoc = doc;
  pathEl.textContent = doc ? (doc.path ?? doc.title) : t("statusbar.noFile");
  encodingEl.textContent = doc
    ? doc.withBom
      ? t("statusbar.encodingWithBom", doc.encoding)
      : doc.encoding
    : "";
  lineEndingEl.textContent = doc?.lineEnding ?? "";
  warningEl.hidden = !doc?.malformed;
  // Truncated (large-file preview) and userReadOnly share this one badge
  // slot rather than each getting their own — truncated wins when both
  // are true (its own, more specific "preview of an N-size file" message
  // still applies regardless of the user's own lock), matching
  // isEffectivelyReadOnly's precedence (tabs.ts).
  readonlyEl.hidden = !doc || !(doc.truncated || doc.userReadOnly);
  readonlyEl.textContent = doc?.truncated
    ? t("statusbar.readonlyPreview", formatSize(doc.totalSize))
    : doc?.userReadOnly
      ? t("statusbar.userReadOnly")
      : "";
}

/** Re-render the status bar after a locale change, using the last known
 *  document (the caller doesn't need to re-supply it). */
export function refreshStatusBar(): void {
  applyStaticLabels();
  updateStatusBar(lastDoc);
}
