// Encoding-detection diagnostics popup: shows the evidence behind the
// current document's encoding (BOM found, chardetng verdict) so the "Why
// {encoding}?" status-bar item has something to display. Read-only — it
// never changes the open document.
import { isManualOnlyEncoding } from "./encodings";
import { t } from "./i18n";
import { explainDetection, type DetectionExplanation } from "./ipc";
import { formatSize } from "./statusbar";

function reasonLabel(reason: string): string {
  switch (reason) {
    case "bom":
      return t("detectcard.reasonBom");
    case "extension":
      return t("detectcard.reasonExtension");
    case "detector":
      return t("detectcard.reasonDetector");
    case "fallback":
      return t("detectcard.reasonFallback");
    default:
      return reason;
  }
}

/** Pure helper: split "{encoding} ({reason})" back into its parts. */
export function parseWouldChoose(wouldChoose: string): {
  encoding: string;
  reason: string;
} {
  const match = /^(.*) \(([a-z]+)\)$/.exec(wouldChoose);
  if (!match) return { encoding: wouldChoose, reason: "detector" };
  return { encoding: match[1], reason: match[2] };
}

export interface DetectionCardRow {
  label: string;
  value: string;
}

export interface DetectionCardModel {
  title: string;
  rows: DetectionCardRow[];
  /** Set when the document's current encoding differs from what auto-detect
   * would choose — i.e. it was picked manually (or inherited from a manual
   * reopen), not by the detector that ran on open. */
  manualNote: string | null;
  /** Set whenever the *current* encoding is one chardetng's statistical
   * detector can never itself produce (see encodings.ts's
   * `MANUAL_ONLY_ENCODINGS`) — independent of `manualNote`/`reason`, since
   * even a document that reached this encoding via a per-extension default
   * (reason=extension, no mismatch, no `manualNote`) still needs the same
   * "this isn't a bug, this encoding always requires one of those paths"
   * context. */
  detectionBoundaryNote: string | null;
  /** Set when `info.largeFilePreview` is true and the verdict wasn't
   * decided by a BOM (issue #201): `detectorVerdict`/`wouldChoose` above
   * come from a statistical read of a truncated large-file-preview sample,
   * not the whole file — for a single very long line with no newlines,
   * that read can land on the wrong encoding family with no `malformed`
   * flag to catch it. A BOM is read from the first few bytes regardless of
   * file size, so it is exactly as reliable here as on the whole file and
   * never gets this note (`reason === "bom"` is excluded below). This is a
   * pure information-disclosure signal — it never changes what
   * `detectorVerdict`/`wouldChoose` themselves report. */
  truncatedSampleNote: string | null;
}

export interface DetectionEvidence {
  /** BOM / chardetng verdict / sampled-range / would-choose rows — every
   *  row `formatDetectionCard` shows except "File" (the caller already
   *  knows which file this is) and "Currently using" (the caller already
   *  shows the document's own encoding elsewhere). */
  rows: DetectionCardRow[];
  manualNote: string | null;
  detectionBoundaryNote: string | null;
  truncatedSampleNote: string | null;
}

/**
 * Pure helper: the detection-evidence rows and notes, without the "File"/
 * "Currently using" framing `formatDetectionCard` below adds for its own
 * status-bar popup. Split out so the Document Info dialog (ROADMAP.md v0.6
 * E1, docinfo.ts) can reuse the exact same evidence — including the
 * large-file truncated-sample warning — as its own "Encoding" section
 * without a second, independently-drifting formatter; `formatDetectionCard`
 * itself is now a thin wrapper around this.
 */
export function formatDetectionEvidence(
  currentEncoding: string,
  info: DetectionExplanation,
): DetectionEvidence {
  const { encoding: detectedEncoding, reason } = parseWouldChoose(
    info.wouldChoose,
  );
  const manualNote =
    currentEncoding === detectedEncoding
      ? null
      : t("detectcard.manualNote", currentEncoding, detectedEncoding);
  const detectionBoundaryNote = isManualOnlyEncoding(currentEncoding)
    ? t("detectcard.detectionBoundaryNote", currentEncoding)
    : null;
  const truncatedSampleNote =
    info.largeFilePreview && reason !== "bom"
      ? t("detectcard.truncatedSampleNote")
      : null;

  return {
    rows: [
      { label: t("detectcard.labelBom"), value: info.bom ?? t("detectcard.noBom") },
      { label: t("detectcard.labelVerdict"), value: info.detectorVerdict },
      {
        label: t("detectcard.labelSampled"),
        value:
          info.sampledBytes >= info.totalSize
            ? t("detectcard.sampledAll", formatSize(info.totalSize))
            : t(
                "detectcard.sampledPartial",
                formatSize(info.sampledBytes),
                formatSize(info.totalSize),
              ),
      },
      {
        label: t("detectcard.labelWouldChoose"),
        value: t("detectcard.wouldChooseValue", detectedEncoding, reasonLabel(reason)),
      },
    ],
    manualNote,
    detectionBoundaryNote,
    truncatedSampleNote,
  };
}

/** Pure helper: assemble the diagnostic card's text from raw evidence. */
export function formatDetectionCard(
  title: string,
  currentEncoding: string,
  info: DetectionExplanation,
): DetectionCardModel {
  const evidence = formatDetectionEvidence(currentEncoding, info);
  return {
    title: t("detectcard.title", currentEncoding),
    rows: [
      { label: t("detectcard.labelFile"), value: title },
      ...evidence.rows,
      { label: t("detectcard.labelCurrentlyUsing"), value: currentEncoding },
    ],
    manualNote: evidence.manualNote,
    detectionBoundaryNote: evidence.detectionBoundaryNote,
    truncatedSampleNote: evidence.truncatedSampleNote,
  };
}

function renderCard(panel: HTMLElement, model: DetectionCardModel): void {
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.className = "detectcard-header";
  header.textContent = model.title;
  panel.appendChild(header);

  const table = document.createElement("dl");
  table.className = "detectcard-rows";
  for (const row of model.rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    table.appendChild(dt);
    table.appendChild(dd);
  }
  panel.appendChild(table);

  if (model.manualNote) {
    const note = document.createElement("div");
    note.className = "detectcard-note";
    note.textContent = model.manualNote;
    panel.appendChild(note);
  }

  if (model.detectionBoundaryNote) {
    const note = document.createElement("div");
    note.className = "detectcard-note";
    note.textContent = model.detectionBoundaryNote;
    panel.appendChild(note);
  }

  if (model.truncatedSampleNote) {
    const note = document.createElement("div");
    note.className = "detectcard-note";
    note.textContent = model.truncatedSampleNote;
    panel.appendChild(note);
  }
}

/**
 * Show the "Why {encoding}?" diagnostics card for `path`, anchored above
 * `anchor` like the status-bar popup menus (no full-screen overlay — this
 * sits alongside "Reopen with Encoding", not as a separate modal).
 * `extensionEncoding` is the same per-extension hint `openDocument` gets,
 * so the card explains the detection that actually ran.
 */
export function showDetectionCard(
  anchor: HTMLElement,
  path: string,
  title: string,
  currentEncoding: string,
  extensionEncoding?: string,
): void {
  if (document.querySelector(".detectcard-panel")) return;

  const panel = document.createElement("div");
  panel.className = "detectcard-panel";
  panel.textContent = t("common.loading");

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    document.removeEventListener("keydown", onKey);
    panel.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  // Deferred so the click that opened the card doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);

  void explainDetection(path, extensionEncoding)
    .then((info) => {
      renderCard(panel, formatDetectionCard(title, currentEncoding, info));
    })
    .catch((error) => {
      panel.textContent = String(error);
    });
}
