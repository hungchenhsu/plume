// Batch encoding and line-ending conversion: scan a folder (dry run),
// review the per-file classification, then convert the convertible subset
// — one atomic write per file on the Rust side (see
// src-tauri/src/batch.rs). Entry point: Edit menu "Batch Encoding
// Conversion…" (see main.ts's "batch_convert" menu event case; the menu
// label predates the line-ending axis and is left as-is — same entry
// point). Mirrors the findinfiles.ts / mojibake.ts overlay-panel pattern.
//
// Files already open in a tab: this module never touches the editor or
// tabs directly. A successful conversion rewrites the file on disk via the
// same atomic-write path a normal Save uses, so the existing file watcher
// (see main.ts's "plume://file-changed" listener / handleExternalChange)
// picks it up exactly like any other external change — reloading a clean
// tab silently, or prompting before discarding a dirty one. Conversion
// never goes through saveFlow, so it never populates `recentSaves`; the
// watcher-echo suppression that exists for normal Save is correctly absent
// here, and the reload prompt fires as expected. See this PR's report for
// the full trace.
//
// Two orthogonal axes, mirroring src-tauri/src/batch.rs: the encoding
// dropdown's first option is a "keep current encoding" pseudo-choice
// (value "keep"), and the line-ending dropdown in `.batchconvert-options`
// offers Keep/LF/CRLF (default Keep). Either axis alone, or both together,
// drives the scan/convert calls; "keep"+"keep" naturally reports every
// file alreadyTarget (nothing to change), which disables Convert without
// any special-case UI code.
import {
  confirm as confirmDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import { encodingChoices, type EncodingChoice } from "./encodings";
import { t } from "./i18n";
import {
  executeBatchConversion,
  scanBatchConversion,
  type BatchConvertResult,
  type BatchEntry,
} from "./ipc";

let lastFolder: string | null = null;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Sentinel `target_encoding` value meaning "leave each file's own
 *  encoding untouched" — see src-tauri/src/batch.rs's `resolve_target_encoding`. */
export const KEEP_ENCODING = "keep";

/**
 * The batch dialog's target-encoding choices: `encodingChoices()` (shared
 * with the reopen/save/preferences pickers) with a "keep current encoding"
 * pseudo-choice prepended. Only meaningful for batch conversion's two-axis
 * design, so this stays local rather than polluting the shared list.
 */
export function batchEncodingChoices(): EncodingChoice[] {
  return [
    { label: t("batchConvert.keepEncoding"), value: KEEP_ENCODING, withBom: false },
    ...encodingChoices(),
  ];
}

export interface LineEndingChoice {
  label: string;
  value: string;
}

/** The batch dialog's target-line-ending choices, "keep" first (the
 *  default selection). Values match src-tauri/src/batch.rs's `line_ending`
 *  argument ("keep" | "LF" | "CRLF") directly — no index-based lookup
 *  needed, unlike `batchEncodingChoices`. */
export function batchLineEndingChoices(): LineEndingChoice[] {
  return [
    { value: "keep", label: t("batchConvert.lineEndingKeep") },
    { value: "LF", label: t("menu.lineEndingLf") },
    { value: "CRLF", label: t("menu.lineEndingCrlf") },
  ];
}

/** Display text for a report row's detected-line-ending cell. "LF"/"CRLF"
 *  stay as the international abbreviation (same convention as the menu's
 *  line-ending labels); "Mixed" is localized since it's prose, not a
 *  standard abbreviation. Empty string (unknown, e.g. `tooLarge`) passes
 *  through unchanged. */
export function lineEndingDisplay(value: string): string {
  return value === "Mixed" ? t("batchConvert.lineEndingMixed") : value;
}

/**
 * Parse the comma-separated extension filter into a lowercase, dot-less,
 * de-duplicated list — matching what `scan_batch_conversion` expects. An
 * empty result means "all files". Pure helper, vitest-covered directly.
 */
export function parseExtensions(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const ext = raw.trim().replace(/^\.+/, "").toLowerCase();
    if (ext) seen.add(ext);
  }
  return [...seen];
}

export interface BatchCounts {
  convertible: number;
  alreadyTarget: number;
  lossy: number;
  undecodable: number;
  tooLarge: number;
}

/** Pure helper: tally scan entries by status for the report header. */
export function countByStatus(entries: BatchEntry[]): BatchCounts {
  const counts: BatchCounts = {
    convertible: 0,
    alreadyTarget: 0,
    lossy: 0,
    undecodable: 0,
    tooLarge: 0,
  };
  for (const entry of entries) {
    if (entry.status in counts) {
      counts[entry.status as keyof BatchCounts] += 1;
    }
  }
  return counts;
}

/** Pure helper: paths eligible for conversion, in report order. */
export function convertiblePaths(entries: BatchEntry[]): string[] {
  return entries.filter((e) => e.status === "convertible").map((e) => e.path);
}

/**
 * Pure helper: convertible paths still selected for conversion, in report
 * order — every path from `convertiblePaths(entries)` except those the
 * user has excluded via the report's per-row checkbox. `unchecked` holds
 * exactly those excluded paths; an empty set (the default after every
 * fresh report) means everything convertible stays selected, matching
 * the pre-checkbox behavior. Paths in `unchecked` that don't belong to a
 * convertible entry (stale, or never eligible in the first place) are
 * silently ignored rather than affecting the result.
 */
export function selectedConvertiblePaths(
  entries: BatchEntry[],
  unchecked: ReadonlySet<string>,
): string[] {
  return convertiblePaths(entries).filter((path) => !unchecked.has(path));
}

function statusLabel(status: string): string {
  switch (status) {
    case "convertible":
      return t("batchConvert.statusConvertible");
    case "alreadyTarget":
      return t("batchConvert.statusAlreadyTarget");
    case "lossy":
      return t("batchConvert.statusLossy");
    case "undecodable":
      return t("batchConvert.statusUndecodable");
    case "tooLarge":
      return t("batchConvert.statusTooLarge");
    default:
      return status;
  }
}

export function showBatchConvert(): void {
  if (document.querySelector(".batchconvert-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "batchconvert-overlay";
  const panel = document.createElement("div");
  panel.className = "batchconvert-panel";

  const header = document.createElement("div");
  header.className = "batchconvert-header";
  header.textContent = t("batchConvert.title");
  panel.appendChild(header);

  const controls = document.createElement("div");
  controls.className = "batchconvert-controls";

  const folderButton = document.createElement("button");
  folderButton.className = "batchconvert-folder";
  folderButton.textContent = lastFolder ? basename(lastFolder) : t("batchConvert.chooseFolder");
  if (lastFolder) folderButton.title = lastFolder;
  folderButton.addEventListener("click", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") {
      lastFolder = folder;
      folderButton.textContent = basename(folder);
      folderButton.title = folder;
      invalidateScan();
    }
  });

  const extInput = document.createElement("input");
  extInput.type = "text";
  extInput.className = "batchconvert-ext";
  extInput.placeholder = t("batchConvert.extPlaceholder");

  const targetLabel = document.createElement("label");
  targetLabel.className = "batchconvert-target";
  targetLabel.textContent = t("batchConvert.targetLabel");
  const encodingSelect = document.createElement("select");
  encodingSelect.className = "batchconvert-encoding";
  const choices = batchEncodingChoices();
  choices.forEach((choice, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = choice.label;
    encodingSelect.appendChild(option);
  });
  targetLabel.appendChild(encodingSelect);

  const scanButton = document.createElement("button");
  scanButton.className = "batchconvert-scan";
  scanButton.textContent = t("batchConvert.scanButton");

  controls.appendChild(folderButton);
  controls.appendChild(extInput);
  controls.appendChild(targetLabel);
  controls.appendChild(scanButton);
  panel.appendChild(controls);

  const lineEndingLabel = document.createElement("label");
  lineEndingLabel.className = "batchconvert-lineending";
  lineEndingLabel.textContent = t("batchConvert.lineEndingLabel");
  const lineEndingSelect = document.createElement("select");
  lineEndingSelect.className = "batchconvert-lineending-select";
  for (const choice of batchLineEndingChoices()) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    lineEndingSelect.appendChild(option);
  }
  lineEndingLabel.appendChild(lineEndingSelect);

  const optionsArea = document.createElement("div");
  optionsArea.className = "batchconvert-options";
  optionsArea.appendChild(lineEndingLabel);
  panel.appendChild(optionsArea);

  const status = document.createElement("div");
  status.className = "batchconvert-status";
  panel.appendChild(status);

  const summary = document.createElement("div");
  summary.className = "batchconvert-summary";
  panel.appendChild(summary);

  const list = document.createElement("div");
  list.className = "batchconvert-list";
  panel.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "batchconvert-actions";
  const convertButton = document.createElement("button");
  convertButton.className = "batchconvert-convert";
  convertButton.textContent = t("batchConvert.convertButton", 0);
  convertButton.disabled = true;
  actions.appendChild(convertButton);
  panel.appendChild(actions);

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    document.removeEventListener("keydown", onKey);
    overlay.remove();
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

  let lastEntries: BatchEntry[] = [];
  // Paths the user has excluded from an otherwise-convertible report via
  // the per-row checkbox (issue #79: a near-miss encoding guess should be
  // excludable without discarding the rest of the batch). Empty means
  // "everything convertible stays selected" — the state after every fresh
  // report — see selectedConvertiblePaths.
  let uncheckedPaths = new Set<string>();

  // The dry-run report is only trustworthy for the exact inputs it was
  // scanned with. Changing the folder, the extension filter, the target
  // encoding, or the target line ending after a scan would let Convert
  // act on a target the user never reviewed (adversarial-review finding)
  // — so any input change voids the report and forces a rescan.
  const invalidateScan = (): void => {
    if (lastEntries.length === 0) return;
    lastEntries = [];
    uncheckedPaths = new Set();
    convertButton.disabled = true;
    convertButton.textContent = t("batchConvert.convertButton", 0);
    summary.textContent = "";
    list.replaceChildren();
    status.textContent = t("batchConvert.rescanNeeded");
  };
  // Every dry-run input is equal-standing: the folder (above), the
  // extension filter, and both target axes changing after a scan must
  // void the report — Convert may only ever act on exactly what the
  // user reviewed.
  extInput.addEventListener("input", invalidateScan);
  encodingSelect.addEventListener("change", invalidateScan);
  lineEndingSelect.addEventListener("change", invalidateScan);

  // Refreshes the Convert button's label/enabled state from the current
  // selection (lastEntries minus uncheckedPaths). Called after every
  // fresh report render and every per-row checkbox toggle.
  const updateConvertButton = (): void => {
    const count = selectedConvertiblePaths(lastEntries, uncheckedPaths).length;
    convertButton.textContent = t("batchConvert.convertButton", count);
    convertButton.disabled = count === 0;
  };

  const renderReport = (entries: BatchEntry[]): void => {
    lastEntries = entries;
    // A fresh report is a fresh review: any exclusions from a previous
    // report must not leak into this one (adversarial-review finding —
    // see invalidateScan above for the same principle on stale inputs).
    uncheckedPaths = new Set();
    const counts = countByStatus(entries);
    summary.textContent =
      entries.length === 0
        ? t("batchConvert.noResults")
        : t(
            "batchConvert.summary",
            counts.convertible,
            counts.alreadyTarget,
            counts.lossy,
            counts.undecodable,
            counts.tooLarge,
          );
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `batchconvert-row batchconvert-row-${entry.status}`;
      // Non-convertible rows still get the grid cell (empty) so every
      // row's path/detected/lineending/status columns line up.
      const checkboxEl = document.createElement("span");
      checkboxEl.className = "batchconvert-row-checkbox";
      if (entry.status === "convertible") {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.setAttribute("aria-label", t("batchConvert.includeFileLabel"));
        checkbox.title = t("batchConvert.includeFileLabel");
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            uncheckedPaths.delete(entry.path);
          } else {
            uncheckedPaths.add(entry.path);
          }
          updateConvertButton();
        });
        checkboxEl.appendChild(checkbox);
      }
      const pathEl = document.createElement("span");
      pathEl.className = "batchconvert-row-path";
      pathEl.textContent = basename(entry.path);
      pathEl.title = entry.path;
      const detectedEl = document.createElement("span");
      detectedEl.className = "batchconvert-row-detected";
      detectedEl.textContent = entry.detected;
      const lineEndingEl = document.createElement("span");
      lineEndingEl.className = "batchconvert-row-lineending";
      lineEndingEl.textContent = lineEndingDisplay(entry.lineEnding);
      const statusEl = document.createElement("span");
      statusEl.className = "batchconvert-row-status";
      statusEl.textContent = statusLabel(entry.status);
      row.appendChild(checkboxEl);
      row.appendChild(pathEl);
      row.appendChild(detectedEl);
      row.appendChild(lineEndingEl);
      row.appendChild(statusEl);
      list.appendChild(row);
    }
    updateConvertButton();
  };

  const renderResults = (results: BatchConvertResult[]): void => {
    const failed = results.filter((r) => !r.ok);
    const okCount = results.length - failed.length;
    status.textContent = t("batchConvert.resultSummary", okCount, failed.length);
    summary.textContent = "";
    list.replaceChildren();
    for (const result of failed) {
      const row = document.createElement("div");
      row.className = "batchconvert-row batchconvert-row-failed";
      // Empty placeholder so the path/message columns still line up with
      // the report view's checkbox/path/detected/lineending/status grid.
      const checkboxEl = document.createElement("span");
      checkboxEl.className = "batchconvert-row-checkbox";
      const pathEl = document.createElement("span");
      pathEl.className = "batchconvert-row-path";
      pathEl.textContent = basename(result.path);
      pathEl.title = result.path;
      const messageEl = document.createElement("span");
      messageEl.className = "batchconvert-row-detected";
      messageEl.textContent = result.message;
      row.appendChild(checkboxEl);
      row.appendChild(pathEl);
      row.appendChild(messageEl);
      list.appendChild(row);
    }
    lastEntries = [];
    uncheckedPaths = new Set();
    convertButton.disabled = true;
    convertButton.textContent = t("batchConvert.convertButton", 0);
  };

  let busy = false;

  const runScan = async (): Promise<void> => {
    if (busy) return;
    if (!lastFolder) {
      status.textContent = t("batchConvert.chooseFolderFirst");
      return;
    }
    busy = true;
    scanButton.disabled = true;
    convertButton.disabled = true;
    status.textContent = t("batchConvert.scanning");
    summary.textContent = "";
    list.replaceChildren();
    try {
      const choice = choices[Number(encodingSelect.value)];
      const report = await scanBatchConversion(
        lastFolder,
        parseExtensions(extInput.value),
        choice.value,
        choice.withBom,
        lineEndingSelect.value,
      );
      status.textContent = "";
      renderReport(report.entries);
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      scanButton.disabled = false;
    }
  };
  scanButton.addEventListener("click", () => void runScan());

  const runConvert = async (): Promise<void> => {
    if (busy) return;
    const paths = selectedConvertiblePaths(lastEntries, uncheckedPaths);
    if (paths.length === 0) return;
    // N files rewritten in place with no undo: make the user say so.
    const proceed = await confirmDialog(
      t("batchConvert.confirmMessage", paths.length),
      { title: t("batchConvert.title"), kind: "warning" },
    ).catch(() => false);
    if (!proceed) return;
    busy = true;
    scanButton.disabled = true;
    convertButton.disabled = true;
    status.textContent = t("batchConvert.converting");
    try {
      const choice = choices[Number(encodingSelect.value)];
      const results = await executeBatchConversion(
        paths,
        choice.value,
        choice.withBom,
        lineEndingSelect.value,
      );
      renderResults(results);
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      scanButton.disabled = false;
    }
  };
  convertButton.addEventListener("click", () => void runConvert());

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  if (lastFolder) extInput.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}
