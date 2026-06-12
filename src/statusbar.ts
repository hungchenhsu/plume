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

export function updateCursor(line: number, column: number): void {
  cursorEl.textContent = `Ln ${line}, Col ${column}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function updateStatusBar(doc: StatusInfo | null): void {
  pathEl.textContent = doc ? (doc.path ?? doc.title) : "No file";
  encodingEl.textContent = doc
    ? doc.withBom
      ? `${doc.encoding} BOM`
      : doc.encoding
    : "";
  lineEndingEl.textContent = doc?.lineEnding ?? "";
  warningEl.hidden = !doc?.malformed;
  readonlyEl.hidden = !doc?.truncated;
  readonlyEl.textContent = doc?.truncated
    ? `Read-only preview of ${formatSize(doc.totalSize)} file`
    : "";
}
