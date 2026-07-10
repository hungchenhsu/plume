import { t } from "./i18n";

interface StatusInfo {
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
  truncated: boolean;
  totalSize: number;
}

const pathEl = document.querySelector<HTMLElement>("#status-path")!;
const encodingEl = document.querySelector<HTMLElement>("#status-encoding")!;
const lineEndingEl = document.querySelector<HTMLElement>(
  "#status-line-ending",
)!;
const warningEl = document.querySelector<HTMLElement>("#status-warning")!;
const readonlyEl = document.querySelector<HTMLElement>("#status-readonly")!;
const cursorEl = document.querySelector<HTMLElement>("#status-cursor")!;
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
  readonlyEl.hidden = !doc?.truncated;
  readonlyEl.textContent = doc?.truncated
    ? t("statusbar.readonlyPreview", formatSize(doc.totalSize))
    : "";
}

/** Re-render the status bar after a locale change, using the last known
 *  document (the caller doesn't need to re-supply it). */
export function refreshStatusBar(): void {
  applyStaticLabels();
  updateStatusBar(lastDoc);
}
