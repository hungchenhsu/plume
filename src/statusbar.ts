interface StatusInfo {
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
}

const pathEl = document.querySelector<HTMLElement>("#status-path")!;
const encodingEl = document.querySelector<HTMLElement>("#status-encoding")!;
const lineEndingEl = document.querySelector<HTMLElement>(
  "#status-line-ending",
)!;
const warningEl = document.querySelector<HTMLElement>("#status-warning")!;

export function updateStatusBar(doc: StatusInfo | null): void {
  pathEl.textContent = doc ? (doc.path ?? doc.title) : "No file";
  encodingEl.textContent = doc
    ? doc.withBom
      ? `${doc.encoding} BOM`
      : doc.encoding
    : "";
  lineEndingEl.textContent = doc?.lineEnding ?? "";
  warningEl.hidden = !doc?.malformed;
}
