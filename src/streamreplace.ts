// Streaming find/replace for large-file read-only preview windows: the
// in-editor Find/Replace can't be used there (only a bounded slice of the
// file is ever loaded, and saving that slice back would destroy the rest of
// the file), so this panel calls the Rust streaming replace command
// directly against the file on disk (src-tauri/src/streamreplace.rs) and
// asks the caller to reload the document afterward. Entry point: Edit menu
// "Replace in Large File…" (see main.ts's "stream_replace" menu event
// case). Mirrors the findinfiles.ts / batchconvert.ts overlay-panel
// pattern.
//
// A successful run with at least one replacement is confirmed with a
// blocking native dialog (so the count is actually seen, not just flashed
// in a status line the panel closes over) before the caller reloads the
// document and the panel closes; zero matches or a failed run show their
// result inline and leave the panel open so the user can adjust and retry
// without losing their input.
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { streamReplaceInFile } from "./ipc";

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Show the streaming replace overlay for `path` (the active large-file
 * document's file on disk), operating in `encoding` (the document's own
 * detected encoding — this command never converts between encodings).
 * `onReplaced` is called once, after a run that made at least one
 * replacement, so the caller can reload the document from disk (e.g.
 * `reloadFromDisk`).
 */
export function showStreamReplace(
  path: string,
  encoding: string,
  onReplaced: () => void,
): void {
  if (document.querySelector(".streamreplace-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "streamreplace-overlay";
  const panel = document.createElement("div");
  panel.className = "streamreplace-panel";

  const title = t("streamReplace.title", basename(path));
  const header = document.createElement("div");
  header.className = "streamreplace-header";
  header.textContent = title;
  header.title = path;
  panel.appendChild(header);

  const fields = document.createElement("div");
  fields.className = "streamreplace-fields";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "streamreplace-search";
  searchInput.placeholder = t("streamReplace.searchPlaceholder");
  // A search term longer than one streaming chunk degrades the Rust side
  // to O(n²) carry growth (documented there); no real search needs 4k.
  searchInput.maxLength = 4096;
  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "streamreplace-replace";
  replaceInput.placeholder = t("streamReplace.replacePlaceholder");
  fields.appendChild(searchInput);
  fields.appendChild(replaceInput);
  panel.appendChild(fields);

  const caseLabel = document.createElement("label");
  caseLabel.className = "streamreplace-case";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseLabel.appendChild(caseBox);
  caseLabel.appendChild(document.createTextNode(t("findInFiles.matchCase")));
  panel.appendChild(caseLabel);

  const hint = document.createElement("div");
  hint.className = "streamreplace-hint";
  hint.textContent = t("streamReplace.caseInsensitiveHint");
  panel.appendChild(hint);

  const status = document.createElement("div");
  status.className = "streamreplace-status";
  panel.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "streamreplace-actions";
  const executeButton = document.createElement("button");
  executeButton.className = "streamreplace-execute";
  executeButton.textContent = t("streamReplace.executeButton");
  actions.appendChild(executeButton);
  panel.appendChild(actions);

  const close = (): void => {
    // A running replace cannot be cancelled — the Rust command will
    // finish and the file will change. Closing the panel mid-run would
    // only fake a cancel, so the panel stays until the run resolves.
    if (busy) return;
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

  let busy = false;
  const updateExecuteEnabled = (): void => {
    executeButton.disabled = busy || searchInput.value === "";
  };
  searchInput.addEventListener("input", updateExecuteEnabled);
  updateExecuteEnabled();

  const runReplace = async (): Promise<void> => {
    if (busy || searchInput.value === "") return;
    busy = true;
    updateExecuteEnabled();
    status.textContent = t("streamReplace.replacing");
    try {
      const report = await streamReplaceInFile(
        path,
        searchInput.value,
        replaceInput.value,
        encoding,
        caseBox.checked,
      );
      const resultMessage = t("streamReplace.resultMessage", report.replacements);
      if (report.replacements > 0) {
        status.textContent = "";
        await messageDialog(resultMessage, { title, kind: "info" });
        onReplaced();
        close();
        return;
      }
      status.textContent = resultMessage;
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      updateExecuteEnabled();
    }
  };
  executeButton.addEventListener("click", () => void runReplace());
  for (const input of [searchInput, replaceInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runReplace();
      }
    });
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  searchInput.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}
