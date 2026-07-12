import { afterEach, describe, expect, it, vi } from "vitest";

const scanBatchConversion = vi.fn();
const executeBatchConversion = vi.fn();
vi.mock("./ipc", () => ({
  scanBatchConversion: (...args: unknown[]) =>
    (scanBatchConversion as (...a: unknown[]) => unknown)(...args),
  executeBatchConversion: (...args: unknown[]) =>
    (executeBatchConversion as (...a: unknown[]) => unknown)(...args),
}));

const openDialog = vi.fn();
const confirmDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => (openDialog as (...a: unknown[]) => unknown)(...args),
  confirm: (...args: unknown[]) => (confirmDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// ./batchconvert is evaluated — same pattern as theme.test.ts.
import {
  batchEncodingChoices,
  batchLineEndingChoices,
  convertiblePaths,
  countByStatus,
  lineEndingDisplay,
  parseExtensions,
  selectedConvertiblePaths,
  showBatchConvert,
} from "./batchconvert";
import { encodingChoices } from "./encodings";
import { t } from "./i18n";
import type { BatchEntry } from "./ipc";

describe("parseExtensions", () => {
  it("splits on commas and trims whitespace", () => {
    expect(parseExtensions(" txt, md ,csv")).toEqual(["txt", "md", "csv"]);
  });

  it("lowercases and strips a leading dot", () => {
    expect(parseExtensions(".TXT, .Md")).toEqual(["txt", "md"]);
  });

  it("strips multiple leading dots", () => {
    expect(parseExtensions("..txt")).toEqual(["txt"]);
  });

  it("drops empty segments from stray commas", () => {
    expect(parseExtensions("txt,,md,")).toEqual(["txt", "md"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseExtensions("txt,TXT,txt")).toEqual(["txt"]);
  });

  it("returns an empty array for blank input (matches every file)", () => {
    expect(parseExtensions("")).toEqual([]);
    expect(parseExtensions("   ")).toEqual([]);
    expect(parseExtensions(",,,")).toEqual([]);
  });
});

function entry(status: string, path = `/f-${status}.txt`, detected = "Big5"): BatchEntry {
  return { path, detected, status, lineEnding: "LF" };
}

describe("countByStatus", () => {
  it("tallies every known status independently", () => {
    const entries = [
      entry("convertible"),
      entry("convertible"),
      entry("alreadyTarget"),
      entry("lossy"),
      entry("undecodable"),
      entry("tooLarge"),
    ];
    expect(countByStatus(entries)).toEqual({
      convertible: 2,
      alreadyTarget: 1,
      lossy: 1,
      undecodable: 1,
      tooLarge: 1,
    });
  });

  it("returns all zeros for an empty report", () => {
    expect(countByStatus([])).toEqual({
      convertible: 0,
      alreadyTarget: 0,
      lossy: 0,
      undecodable: 0,
      tooLarge: 0,
    });
  });

  it("ignores an unrecognized status rather than throwing", () => {
    expect(countByStatus([entry("somethingNew")])).toEqual({
      convertible: 0,
      alreadyTarget: 0,
      lossy: 0,
      undecodable: 0,
      tooLarge: 0,
    });
  });
});

describe("convertiblePaths", () => {
  it("returns only the paths of convertible entries, in report order", () => {
    const entries = [
      entry("convertible", "/a.txt"),
      entry("alreadyTarget", "/b.txt"),
      entry("convertible", "/c.txt"),
      entry("lossy", "/d.txt"),
    ];
    expect(convertiblePaths(entries)).toEqual(["/a.txt", "/c.txt"]);
  });

  it("returns an empty array when nothing is convertible", () => {
    expect(convertiblePaths([entry("alreadyTarget"), entry("tooLarge")])).toEqual([]);
  });

  it("returns an empty array for an empty report", () => {
    expect(convertiblePaths([])).toEqual([]);
  });
});

describe("selectedConvertiblePaths", () => {
  it("returns every convertible path when nothing is unchecked (all-checked, matches pre-checkbox behavior)", () => {
    const entries = [
      entry("convertible", "/a.txt"),
      entry("alreadyTarget", "/b.txt"),
      entry("convertible", "/c.txt"),
    ];
    expect(selectedConvertiblePaths(entries, new Set())).toEqual(["/a.txt", "/c.txt"]);
  });

  it("excludes only the unchecked convertible paths, preserving report order (partially checked)", () => {
    const entries = [
      entry("convertible", "/a.txt"),
      entry("convertible", "/b.txt"),
      entry("convertible", "/c.txt"),
    ];
    expect(selectedConvertiblePaths(entries, new Set(["/b.txt"]))).toEqual(["/a.txt", "/c.txt"]);
  });

  it("returns an empty array when every convertible path is unchecked (all-unchecked)", () => {
    const entries = [entry("convertible", "/a.txt"), entry("convertible", "/b.txt")];
    expect(selectedConvertiblePaths(entries, new Set(["/a.txt", "/b.txt"]))).toEqual([]);
  });

  it("never lets a non-convertible row's path affect the result, even if it appears in unchecked", () => {
    const entries = [
      entry("convertible", "/a.txt"),
      entry("alreadyTarget", "/b.txt"),
      entry("lossy", "/c.txt"),
    ];
    // /b.txt and /c.txt were never eligible in the first place — marking
    // them "unchecked" is a no-op since convertiblePaths() already drops
    // them; only a convertible row's checkbox can change the outcome.
    expect(selectedConvertiblePaths(entries, new Set(["/b.txt", "/c.txt"]))).toEqual(["/a.txt"]);
  });

  it("ignores stale paths in unchecked that don't appear in entries at all", () => {
    const entries = [entry("convertible", "/a.txt")];
    expect(selectedConvertiblePaths(entries, new Set(["/nonexistent.txt"]))).toEqual(["/a.txt"]);
  });

  it("returns an empty array for an empty report regardless of unchecked contents", () => {
    expect(selectedConvertiblePaths([], new Set(["/a.txt"]))).toEqual([]);
  });

  it("treats a fresh empty Set (the post-reset state after invalidateScan/renderReport) as fully selected again", () => {
    const entries = [entry("convertible", "/a.txt"), entry("convertible", "/b.txt")];
    const staleUnchecked = new Set(["/a.txt"]);
    expect(selectedConvertiblePaths(entries, staleUnchecked)).toEqual(["/b.txt"]);
    // A rescan replaces the closure's uncheckedPaths with `new Set()`
    // (see invalidateScan/renderReport in batchconvert.ts) rather than
    // carrying the old exclusion forward — simulate that reset here.
    expect(selectedConvertiblePaths(entries, new Set())).toEqual(["/a.txt", "/b.txt"]);
  });
});

describe("batchEncodingChoices", () => {
  it("prepends a keep-current-encoding pseudo-choice as the first option", () => {
    const choices = batchEncodingChoices();
    expect(choices[0].value).toBe("keep");
  });

  it("otherwise matches the shared encodingChoices list exactly", () => {
    expect(batchEncodingChoices().slice(1)).toEqual(encodingChoices());
  });
});

describe("batchLineEndingChoices", () => {
  it("defaults to keep, followed by LF and CRLF", () => {
    const choices = batchLineEndingChoices();
    expect(choices.map((c) => c.value)).toEqual(["keep", "LF", "CRLF"]);
  });

  it("gives every choice a non-empty label", () => {
    for (const choice of batchLineEndingChoices()) {
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });
});

describe("lineEndingDisplay", () => {
  it("passes LF, CRLF, and CR through unchanged", () => {
    expect(lineEndingDisplay("LF")).toBe("LF");
    expect(lineEndingDisplay("CRLF")).toBe("CRLF");
    // "CR" (lone \r, Classic Mac line endings — issue #82): batch
    // conversion never targets CR, but a source file's *detected* line
    // ending can be CR and must still render in the scan report.
    expect(lineEndingDisplay("CR")).toBe("CR");
  });

  it("looks up Mixed through the i18n dictionary rather than passing it through raw", () => {
    expect(lineEndingDisplay("Mixed")).toBe(t("batchConvert.lineEndingMixed"));
  });

  it("passes an empty (unknown) value through unchanged", () => {
    expect(lineEndingDisplay("")).toBe("");
  });
});

// showBatchConvert builds its own DOM (no framework), and batchconvert.ts
// never touches the WebView directly, so this is driveable in jsdom same
// as theme.test.ts drives preferences.ts — see the vi.mock block up top.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise plus its resolve/reject, exposed for manual settlement —
 *  lets a test hold an IPC mock's response open across other synchronous
 *  actions (e.g. an input change) before deciding when it "arrives". */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function checkboxes(panel: HTMLElement): HTMLInputElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLInputElement>(".batchconvert-row-checkbox input[type=checkbox]"),
  );
}

async function openAndScan(entries: BatchEntry[]): Promise<HTMLElement> {
  openDialog.mockResolvedValue("/some/folder");
  scanBatchConversion.mockResolvedValue({ entries });
  showBatchConvert();
  const panel = document.querySelector(".batchconvert-panel") as HTMLElement;
  (panel.querySelector(".batchconvert-folder") as HTMLButtonElement).click();
  await flush();
  (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
  await flush();
  return panel;
}

describe("showBatchConvert — per-row checkbox (DOM)", () => {
  afterEach(() => {
    // Let the currently-open dialog's own Escape handler clean up its
    // document-level listeners (mirrors a real dismiss); the overlay
    // removal is a fallback in case nothing was open.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelector(".batchconvert-overlay")?.remove();
    scanBatchConversion.mockReset();
    executeBatchConversion.mockReset();
    openDialog.mockReset();
    confirmDialog.mockReset();
  });

  it("gives every convertible row a checked checkbox, and non-convertible rows none", async () => {
    const panel = await openAndScan([
      entry("convertible", "/a.txt"),
      entry("alreadyTarget", "/b.txt"),
      entry("lossy", "/c.txt"),
    ]);
    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(3);
    const boxes = checkboxes(panel);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].checked).toBe(true);
  });

  it("unchecking a row lowers the Convert button's count; re-checking restores it", async () => {
    const panel = await openAndScan([
      entry("convertible", "/a.txt"),
      entry("convertible", "/b.txt"),
    ]);
    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 2));
    expect(convertButton.disabled).toBe(false);

    const boxes = checkboxes(panel);
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event("change"));
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 1));
    expect(convertButton.disabled).toBe(false);

    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change"));
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 2));
  });

  it("disables Convert once every row is unchecked", async () => {
    const panel = await openAndScan([entry("convertible", "/a.txt")]);
    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    const box = checkboxes(panel)[0];
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(convertButton.disabled).toBe(true);
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 0));
  });

  it("Convert sends only the checked subset, and the confirm prompt counts only those", async () => {
    const panel = await openAndScan([
      entry("convertible", "/a.txt"),
      entry("convertible", "/b.txt"),
      entry("convertible", "/c.txt"),
    ]);
    const boxes = checkboxes(panel);
    boxes[1].checked = false; // exclude /b.txt
    boxes[1].dispatchEvent(new Event("change"));

    confirmDialog.mockResolvedValue(true);
    executeBatchConversion.mockResolvedValue([
      { path: "/a.txt", ok: true, message: "" },
      { path: "/c.txt", ok: true, message: "" },
    ]);
    (panel.querySelector(".batchconvert-convert") as HTMLButtonElement).click();
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith(
      t("batchConvert.confirmMessage", 2),
      expect.objectContaining({ title: t("batchConvert.title") }),
    );
    expect(executeBatchConversion).toHaveBeenCalledWith(
      ["/a.txt", "/c.txt"],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("invalidating the scan after an exclusion clears checkbox state — the next report starts fully selected", async () => {
    const panel = await openAndScan([
      entry("convertible", "/a.txt"),
      entry("convertible", "/b.txt"),
    ]);
    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    checkboxes(panel)[0].checked = false;
    checkboxes(panel)[0].dispatchEvent(new Event("change"));
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 1));

    // Changing the extension filter voids the report (existing
    // invalidateScan behavior, unrelated to this feature) — Convert must
    // go back to disabled/0 and every row must disappear.
    const extInput = panel.querySelector(".batchconvert-ext") as HTMLInputElement;
    extInput.value = "md";
    extInput.dispatchEvent(new Event("input"));
    expect(convertButton.disabled).toBe(true);
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 0));
    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(0);

    // Rescanning must start fully selected again: /a.txt's earlier
    // exclusion must not survive invalidateScan into the new report.
    scanBatchConversion.mockResolvedValueOnce({
      entries: [entry("convertible", "/a.txt"), entry("convertible", "/b.txt")],
    });
    (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
    await flush();
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 2));
    const boxes = checkboxes(panel);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(true);
  });
});

// Issue #95 (P1): a scan's dry-run report and Convert's actual execution
// parameters could decouple. Two independent failure modes, covered
// separately below: (1) a scan response that arrives after the inputs
// changed could still render, because invalidateScan did nothing while
// lastEntries was still empty (e.g. a first scan still in flight); (2)
// even a legitimately-rendered report's Convert re-read the *current*
// encoding/line-ending controls instead of the ones the report was
// scanned with.
describe("showBatchConvert — stale scan response discarded (issue #95)", () => {
  afterEach(() => {
    // Mirrors the per-row checkbox describe block above: let the open
    // dialog's own Escape handler clean up its document-level listeners.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelector(".batchconvert-overlay")?.remove();
    scanBatchConversion.mockReset();
    executeBatchConversion.mockReset();
    openDialog.mockReset();
    confirmDialog.mockReset();
  });

  it("a scan superseded by an input change before it resolves is discarded unrendered, and does not enable Convert", async () => {
    openDialog.mockResolvedValue("/some/folder");
    const scanA = deferred<{ entries: BatchEntry[] }>();
    scanBatchConversion.mockReturnValueOnce(scanA.promise);

    showBatchConvert();
    const panel = document.querySelector(".batchconvert-panel") as HTMLElement;
    (panel.querySelector(".batchconvert-folder") as HTMLButtonElement).click();
    await flush();

    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    const encodingSelect = panel.querySelector(".batchconvert-encoding") as HTMLSelectElement;

    // Start scan A; its IPC promise is left unresolved (still in flight).
    (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
    await flush();
    expect(scanBatchConversion).toHaveBeenCalledTimes(1);

    // Switch the target to B before A resolves. lastEntries is still []
    // here — no report has ever rendered — which is exactly the state the
    // old invalidateScan's `lastEntries.length === 0` early return did
    // nothing for; it must still invalidate A's in-flight request.
    encodingSelect.value = "1";
    encodingSelect.dispatchEvent(new Event("change"));

    // A's stale response now arrives.
    scanA.resolve({ entries: [entry("convertible", "/a.txt")] });
    await flush();

    // Discarded outright: no rows rendered, Convert not enabled by a
    // report scanned for A that nobody reviewed against B.
    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(0);
    expect(convertButton.disabled).toBe(true);

    // A real scan under B completes next and must render/enable
    // normally — proving the discard above isn't a permanently stuck
    // state.
    const scanB = deferred<{ entries: BatchEntry[] }>();
    scanBatchConversion.mockReturnValueOnce(scanB.promise);
    (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
    await flush();
    scanB.resolve({ entries: [entry("convertible", "/b.txt")] });
    await flush();

    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(1);
    expect(convertButton.disabled).toBe(false);
    expect(convertButton.textContent).toBe(t("batchConvert.convertButton", 1));
  });

  it("a superseded scan that rejects is discarded without disturbing the current state", async () => {
    openDialog.mockResolvedValue("/some/folder");
    const scanA = deferred<{ entries: BatchEntry[] }>();
    scanBatchConversion.mockReturnValueOnce(scanA.promise);

    showBatchConvert();
    const panel = document.querySelector(".batchconvert-panel") as HTMLElement;
    (panel.querySelector(".batchconvert-folder") as HTMLButtonElement).click();
    await flush();

    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    const encodingSelect = panel.querySelector(".batchconvert-encoding") as HTMLSelectElement;

    (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
    await flush();

    // Supersede A, then let A's IPC reject: the stale error must not clobber
    // the (now B-oriented) state — same generation guard as the success path.
    encodingSelect.value = "1";
    encodingSelect.dispatchEvent(new Event("change"));
    scanA.reject(new Error("stale scan failed"));
    await flush();

    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(0);
    expect(convertButton.disabled).toBe(true);

    // A fresh scan under B still works — the discard didn't wedge anything.
    const scanB = deferred<{ entries: BatchEntry[] }>();
    scanBatchConversion.mockReturnValueOnce(scanB.promise);
    (panel.querySelector(".batchconvert-scan") as HTMLButtonElement).click();
    await flush();
    scanB.resolve({ entries: [entry("convertible", "/b.txt")] });
    await flush();

    expect(panel.querySelectorAll(".batchconvert-row")).toHaveLength(1);
    expect(convertButton.disabled).toBe(false);
  });

  it("Convert executes with the scan's bound parameter snapshot, not the controls' current values", async () => {
    const panel = await openAndScan([entry("convertible", "/a.txt")]);
    // openAndScan scans with both selects at their default (index 0 —
    // KEEP_ENCODING — and "keep" line ending).
    const convertButton = panel.querySelector(".batchconvert-convert") as HTMLButtonElement;
    const encodingSelect = panel.querySelector(".batchconvert-encoding") as HTMLSelectElement;
    const lineEndingSelect = panel.querySelector(
      ".batchconvert-lineending-select",
    ) as HTMLSelectElement;

    // Move the controls to a different target directly, without the
    // change event that would otherwise invalidate the report — isolating
    // what runConvert itself reads from. It must be the bound snapshot,
    // never these elements, regardless of how their values came to
    // differ from what was scanned.
    encodingSelect.value = "1";
    lineEndingSelect.value = "CRLF";

    confirmDialog.mockResolvedValue(true);
    executeBatchConversion.mockResolvedValue([{ path: "/a.txt", ok: true, message: "" }]);
    convertButton.click();
    await flush();

    const scannedChoice = batchEncodingChoices()[0];
    expect(executeBatchConversion).toHaveBeenCalledWith(
      ["/a.txt"],
      scannedChoice.value,
      scannedChoice.withBom,
      "keep",
    );
  });
});
