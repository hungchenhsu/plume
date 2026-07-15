import { afterEach, describe, expect, it, vi } from "vitest";

const searchInFolder = vi.fn();
vi.mock("./ipc", () => ({
  searchInFolder: (...args: unknown[]) =>
    (searchInFolder as (...a: unknown[]) => unknown)(...args),
}));

const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => (openDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// ./findinfiles is evaluated — same pattern as batchconvert.test.ts.
import { showFindInFiles } from "./findinfiles";
import { t } from "./i18n";
import type { SearchMatch, SearchResults, SearchScanError } from "./ipc";

// showFindInFiles builds its own DOM (no framework) and never touches the
// WebView directly, so this is driveable in jsdom — same as
// batchconvert.test.ts drives showBatchConvert.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scanError(path: string, message = "Permission denied (os error 13)"): SearchScanError {
  return { path, message };
}

/** Builds a full `SearchResults` mock, defaulting to an exhaustive search
 *  (no `scanErrors`, one match). */
function results(
  matches: SearchMatch[],
  scanErrors: SearchScanError[] = [],
): SearchResults {
  return { matches, truncated: false, filesScanned: matches.length, scanErrors };
}

async function openAndSearch(
  matches: SearchMatch[],
  scanErrors: SearchScanError[] = [],
): Promise<HTMLElement> {
  openDialog.mockResolvedValue("/some/folder");
  searchInFolder.mockResolvedValue(results(matches, scanErrors));
  showFindInFiles(() => {});
  const panel = document.querySelector(".fif-panel") as HTMLElement;
  (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
  await flush();
  const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
  input.value = "needle";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await flush();
  return panel;
}

// Issue #130: a scan_errors-carrying result (a subdirectory that couldn't
// be listed, an entry whose metadata failed) used to be invisible in the
// UI — the panel had no way to show a search wasn't exhaustive. Mirrors
// batchconvert.test.ts's "incomplete-scan warning (issue #116)" suite,
// minus the confirm-dialog cases: find-in-files has no destructive
// execute step to gate, only the disclosure itself.
describe("showFindInFiles — incomplete-scan warning (issue #130)", () => {
  afterEach(() => {
    // Let the currently-open panel's own outside-click handler clean up
    // its document-level listener (mirrors a real dismiss, since
    // findinfiles.ts — unlike batchconvert.ts — has no document-level
    // keydown handler to fire an Escape at); the overlay removal is a
    // fallback in case nothing was open.
    document.dispatchEvent(new MouseEvent("mousedown"));
    document.querySelector(".fif-overlay")?.remove();
    searchInFolder.mockReset();
    openDialog.mockReset();
  });

  function scanErrorsContainer(panel: HTMLElement): HTMLElement {
    return panel.querySelector(".fif-scan-errors-container") as HTMLElement;
  }

  it("stays hidden when the search was exhaustive (no scanErrors)", async () => {
    const panel = await openAndSearch([{ path: "/a.txt", line: 1, preview: "needle" }]);
    const container = scanErrorsContainer(panel);
    expect(container.hidden).toBe(true);
    expect(container.querySelector("details")).toBeNull();
  });

  it("shows a disclosure naming the count and every unreadable path when scanErrors is non-empty", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [
        scanError("/some/folder/locked", "Permission denied (os error 13)"),
        scanError("/some/folder/noexec/hidden.txt"),
      ],
    );
    const container = scanErrorsContainer(panel);
    expect(container.hidden).toBe(false);
    const summaryEl = container.querySelector("summary");
    expect(summaryEl?.textContent).toBe(t("findInFiles.scanErrorsSummary", 2));
    const rows = container.querySelectorAll(".fif-scan-errors-row");
    expect(rows).toHaveLength(2);
    expect(container.querySelector(".fif-scan-errors-path")?.textContent).toBe("locked");
    expect(container.querySelector(".fif-scan-errors-message")?.textContent).toBe(
      "Permission denied (os error 13)",
    );
  });

  it("a fresh exhaustive search clears a previous search's error banner", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [scanError("/locked")],
    );
    expect(scanErrorsContainer(panel).hidden).toBe(false);

    searchInFolder.mockResolvedValueOnce(
      results([{ path: "/a.txt", line: 1, preview: "needle" }]),
    );
    const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(scanErrorsContainer(panel).hidden).toBe(true);
  });

  it("a new search hides the previous banner immediately, before the response arrives", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [scanError("/locked")],
    );
    expect(scanErrorsContainer(panel).hidden).toBe(false);

    let resolveSearch!: (value: SearchResults) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(scanErrorsContainer(panel).hidden).toBe(true);

    resolveSearch(results([{ path: "/a.txt", line: 1, preview: "needle" }]));
    await flush();
  });
});
