// Find-in-files panel: pick a folder, type a query, click a result to jump.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { searchInFolder, type SearchMatch, type SearchScanError } from "./ipc";

let lastFolder: string | null = null;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function showFindInFiles(
  onPick: (path: string, line: number) => void,
): void {
  if (document.querySelector(".fif-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "fif-overlay";
  const panel = document.createElement("div");
  panel.className = "fif-panel";

  const controls = document.createElement("div");
  controls.className = "fif-controls";

  const folderButton = document.createElement("button");
  folderButton.className = "fif-folder";
  folderButton.textContent = lastFolder
    ? basename(lastFolder)
    : t("findInFiles.chooseFolder");
  if (lastFolder) folderButton.title = lastFolder;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t("findInFiles.searchPlaceholder");

  const caseLabel = document.createElement("label");
  caseLabel.className = "fif-case";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseLabel.appendChild(caseBox);
  caseLabel.appendChild(document.createTextNode("Aa"));
  caseLabel.title = t("findInFiles.matchCase");

  const regexLabel = document.createElement("label");
  regexLabel.className = "fif-case";
  const regexBox = document.createElement("input");
  regexBox.type = "checkbox";
  regexLabel.appendChild(regexBox);
  regexLabel.appendChild(document.createTextNode(".*"));
  regexLabel.title = t("findInFiles.regex");

  controls.appendChild(folderButton);
  controls.appendChild(input);
  controls.appendChild(caseLabel);
  controls.appendChild(regexLabel);
  panel.appendChild(controls);

  const status = document.createElement("div");
  status.className = "fif-status";
  panel.appendChild(status);

  // Issue #130: a folder/entry the walk couldn't read means `matches`
  // below may be missing whatever that path contained. This must stay
  // visible above the results list — not buried where it might go
  // unnoticed — and use <details>/<summary> so the path list is
  // inspectable without cluttering the common (no errors) case. Mirrors
  // batchconvert.ts's identical disclosure for issue #116, styled with
  // this panel's own `.fif-*` classes rather than the batch panel's.
  const scanErrorsEl = document.createElement("div");
  scanErrorsEl.className = "fif-scan-errors-container";
  scanErrorsEl.hidden = true;
  panel.appendChild(scanErrorsEl);

  const list = document.createElement("ul");
  list.className = "fif-list";
  panel.appendChild(list);

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };

  folderButton.addEventListener("click", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") {
      lastFolder = folder;
      folderButton.textContent = basename(folder);
      folderButton.title = folder;
      input.focus();
    }
  });

  const renderMatches = (matches: SearchMatch[]): void => {
    list.replaceChildren();
    for (const match of matches) {
      const item = document.createElement("li");
      item.className = "fif-item";
      const location = document.createElement("span");
      location.className = "fif-location";
      location.textContent = `${basename(match.path)}:${match.line}`;
      location.title = match.path;
      const preview = document.createElement("span");
      preview.className = "fif-preview";
      preview.textContent = match.preview;
      item.appendChild(location);
      item.appendChild(preview);
      item.addEventListener("click", () => {
        close();
        onPick(match.path, match.line);
      });
      list.appendChild(item);
    }
  };

  // Issue #130: renders the "N items could not be searched" disclosure
  // above the results list, or hides the block entirely when the walk was
  // exhaustive (the common case) — same behavior as batchconvert.ts's
  // renderScanErrors for issue #116.
  const renderScanErrors = (scanErrors: SearchScanError[]): void => {
    scanErrorsEl.replaceChildren();
    if (scanErrors.length === 0) {
      scanErrorsEl.hidden = true;
      return;
    }
    scanErrorsEl.hidden = false;
    const details = document.createElement("details");
    details.className = "fif-scan-errors";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = t("findInFiles.scanErrorsSummary", scanErrors.length);
    details.appendChild(summaryEl);
    const errorList = document.createElement("div");
    errorList.className = "fif-scan-errors-list";
    for (const scanError of scanErrors) {
      const row = document.createElement("div");
      row.className = "fif-scan-errors-row";
      const pathEl = document.createElement("span");
      pathEl.className = "fif-scan-errors-path";
      pathEl.textContent = basename(scanError.path);
      pathEl.title = scanError.path;
      const messageEl = document.createElement("span");
      messageEl.className = "fif-scan-errors-message";
      messageEl.textContent = scanError.message;
      row.appendChild(pathEl);
      row.appendChild(messageEl);
      errorList.appendChild(row);
    }
    details.appendChild(errorList);
    scanErrorsEl.appendChild(details);
  };

  let searching = false;
  const runSearch = async (): Promise<void> => {
    if (searching) return;
    const query = input.value;
    if (!lastFolder || query === "") return;
    searching = true;
    status.textContent = t("findInFiles.searching");
    list.replaceChildren();
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    try {
      const results = await searchInFolder(
        lastFolder,
        query,
        caseBox.checked,
        regexBox.checked,
      );
      const count = results.matches.length;
      status.textContent = t(
        "findInFiles.status",
        count,
        results.truncated,
        results.filesScanned,
      );
      renderMatches(results.matches);
      renderScanErrors(results.scanErrors);
    } catch (error) {
      status.textContent = String(error);
    } finally {
      searching = false;
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void runSearch();
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  if (lastFolder) input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
