// Encoding-detection diagnostics popup: shows the evidence behind the
// current document's encoding (BOM found, chardetng verdict) so the "Why
// {encoding}?" status-bar item has something to display. Read-only — it
// never changes the open document.
import { explainDetection, type DetectionExplanation } from "./ipc";
import { formatSize } from "./statusbar";

const REASON_LABELS: Record<string, string> = {
  bom: "a BOM was found",
  extension: "per-extension preference, decoded cleanly",
  detector: "chardetng statistical detection",
  fallback: "no evidence to analyze (empty file), defaulted",
};

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
}

/** Pure helper: assemble the diagnostic card's text from raw evidence. */
export function formatDetectionCard(
  title: string,
  currentEncoding: string,
  info: DetectionExplanation,
): DetectionCardModel {
  const { encoding: detectedEncoding, reason } = parseWouldChoose(
    info.wouldChoose,
  );
  const reasonLabel = REASON_LABELS[reason] ?? reason;
  const manualNote =
    currentEncoding === detectedEncoding
      ? null
      : `Currently using ${currentEncoding} manually — auto-detect would choose ${detectedEncoding}.`;

  return {
    title: `Why ${currentEncoding}?`,
    rows: [
      { label: "File", value: title },
      { label: "BOM", value: info.bom ?? "No BOM found" },
      { label: "chardetng verdict", value: info.detectorVerdict },
      {
        label: "Sampled",
        value:
          info.sampledBytes >= info.totalSize
            ? `all ${formatSize(info.totalSize)}`
            : `first ${formatSize(info.sampledBytes)} of ${formatSize(info.totalSize)}`,
      },
      {
        label: "Auto-detect would choose",
        value: `${detectedEncoding} (${reasonLabel})`,
      },
      { label: "Currently using", value: currentEncoding },
    ],
    manualNote,
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
  panel.textContent = "Loading…";

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
