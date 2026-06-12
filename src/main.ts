import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as confirmDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { createEditor, isEmptyBuffer } from "./editor";
import { ENCODINGS, REOPEN_ENCODINGS } from "./encodings";
import {
  addRecentFile,
  loadRecentFiles,
  loadSession,
  openDocument,
  saveDocument,
  saveSession,
  takePendingFiles,
  unwatchFile,
  watchFile,
  type OpenedDocument,
  type SessionData,
} from "./ipc";
import { showFindInFiles } from "./findinfiles";
import { showGoToLine } from "./goto";
import { showQuickOpen } from "./quickopen";
import { showMenu } from "./popup";
import {
  initPreferences,
  preferences,
  showPreferencesDialog,
} from "./preferences";
import { updateCursor, updateStatusBar } from "./statusbar";
import { TabStore, type Doc } from "./tabs";

const defaultLineEnding = navigator.userAgent.includes("Windows")
  ? "CRLF"
  : "LF";

let nextId = 1;
let untitledCounter = 0;

const tabs = new TabStore(document.querySelector<HTMLElement>("#tabbar")!, {
  onSelect: (id) => activate(id),
  onClose: (id) => void closeTab(id),
  onNew: () => newTab(),
});

const editor = createEditor(
  document.querySelector("#editor")!,
  () => {
    const doc = tabs.active;
    if (doc && !doc.dirty) {
      doc.dirty = true;
      tabs.render();
      updateWindowTitle();
    }
  },
  updateCursor,
);

function updateWindowTitle(): void {
  const doc = tabs.active;
  const title = doc
    ? `${doc.dirty ? "• " : ""}${doc.title} — Plume`
    : "Plume";
  void getCurrentWindow().setTitle(title).catch(() => {
    // Title sync is cosmetic; never surface errors for it.
  });
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function makeUntitled(): Doc {
  untitledCounter += 1;
  return {
    id: nextId++,
    path: null,
    title: untitledCounter === 1 ? "Untitled" : `Untitled-${untitledCounter}`,
    encoding: preferences().defaultEncoding,
    withBom: preferences().defaultBom,
    lineEnding: defaultLineEnding,
    malformed: false,
    dirty: false,
    truncated: false,
    totalSize: 0,
    buffer: editor.newBuffer(""),
  };
}

/** Sync the editor view and status bar to the active tab. */
function showActive(): void {
  const doc = tabs.active;
  if (!doc) return;
  editor.swap(doc.buffer);
  tabs.render();
  updateStatusBar(doc);
  updateWindowTitle();
  editor.focus();
  void editor.setLanguage(doc.title, () => tabs.activeId === doc.id);
}

function collectSession(): SessionData {
  const files = tabs.docs
    .filter((d) => d.path !== null)
    .map((d) => ({ path: d.path!, encoding: d.encoding }));
  const activePath = tabs.active?.path;
  const active = activePath
    ? files.findIndex((f) => f.path === activePath)
    : -1;
  return { files, active: Math.max(active, 0) };
}

function persistSession(): void {
  void saveSession(collectSession()).catch(() => {
    // Session persistence is best-effort; never interrupt editing over it.
  });
}

function activate(id: number): void {
  if (id === tabs.activeId) return;
  const current = tabs.active;
  if (current) current.buffer = editor.snapshot();
  tabs.setActive(id);
  showActive();
  persistSession();
}

function newTab(): void {
  const current = tabs.active;
  if (current) current.buffer = editor.snapshot();
  tabs.add(makeUntitled());
  showActive();
}

function cycleTab(offset: number): void {
  const current = tabs.active;
  if (current) current.buffer = editor.snapshot();
  tabs.cycle(offset);
  showActive();
}

/** An empty, never-edited, never-saved tab that can be silently replaced. */
function isPristineUntitled(doc: Doc): boolean {
  return doc.path === null && !doc.dirty && isEmptyBuffer(doc.buffer);
}

function docFromOpened(opened: OpenedDocument): Doc {
  void watchFile(opened.path).catch(() => {
    // Watching is best-effort; editing must keep working without it.
  });
  return {
    id: nextId++,
    path: opened.path,
    title: basename(opened.path),
    encoding: opened.encoding,
    withBom: opened.hadBom,
    lineEnding: opened.lineEnding,
    malformed: opened.malformed,
    dirty: false,
    truncated: opened.truncated,
    totalSize: opened.totalSize,
    buffer: editor.newBuffer(opened.content, opened.truncated),
  };
}

/** Cached recent-files list, refreshed by the backend on every addition. */
let recentFiles: string[] = [];

function rememberRecent(path: string): void {
  void addRecentFile(path)
    .then((list) => {
      recentFiles = list;
    })
    .catch(() => {
      // Best-effort; quick open just shows a slightly stale list.
    });
}

/** Timestamps of our own saves, to ignore the watcher echo they cause. */
const recentSaves = new Map<string, number>();
/** Paths with a reload-confirmation dialog currently open. */
const reloadPrompts = new Set<string>();

async function reloadFromDisk(doc: Doc): Promise<void> {
  if (!doc.path) return;
  try {
    const opened = await openDocument(doc.path, doc.encoding);
    doc.encoding = opened.encoding;
    doc.withBom = opened.hadBom;
    doc.lineEnding = opened.lineEnding;
    doc.malformed = opened.malformed;
    doc.dirty = false;
    doc.truncated = opened.truncated;
    doc.totalSize = opened.totalSize;
    doc.buffer = editor.newBuffer(opened.content, opened.truncated);
    if (tabs.activeId === doc.id) showActive();
    else tabs.render();
  } catch {
    // The file may be mid-replace or deleted; keep the buffer as-is.
  }
}

async function handleExternalChange(path: string): Promise<void> {
  const doc = tabs.docs.find((d) => d.path === path);
  if (!doc) return;
  const savedAt = recentSaves.get(path) ?? 0;
  if (Date.now() - savedAt < 1500) return;
  if (!doc.dirty) {
    await reloadFromDisk(doc);
    return;
  }
  if (reloadPrompts.has(path)) return;
  reloadPrompts.add(path);
  try {
    const reload = await confirmDialog(
      `"${doc.title}" changed on disk. Reload it and discard your unsaved changes?`,
      { title: "File changed on disk", kind: "warning", okLabel: "Reload" },
    );
    if (reload) await reloadFromDisk(doc);
  } finally {
    reloadPrompts.delete(path);
  }
}

/** Open a file by path into a tab, focusing the existing tab if any. */
async function openPath(path: string): Promise<void> {
  const existing = tabs.findByPath(path);
  if (existing) {
    activate(existing.id);
    return;
  }
  try {
    const opened = await openDocument(path);
    const previous = tabs.active;
    if (previous) previous.buffer = editor.snapshot();
    tabs.add(docFromOpened(opened));
    if (previous && isPristineUntitled(previous)) tabs.close(previous.id);
    showActive();
    persistSession();
    rememberRecent(opened.path);
  } catch (error) {
    await messageDialog(String(error), { title: "Open failed", kind: "error" });
  }
}

async function openFileFlow(): Promise<void> {
  const paths = await openDialog({ multiple: true, directory: false });
  for (const path of paths ?? []) {
    await openPath(path);
  }
}

async function saveFlow(saveAs: boolean): Promise<void> {
  const doc = tabs.active;
  if (!doc) return;
  if (doc.truncated) {
    // Writing the preview slice back would destroy the rest of the file.
    await messageDialog(
      `"${doc.title}" is a read-only preview of a large file; saving is disabled.`,
      { title: "Read-only preview", kind: "warning" },
    );
    return;
  }
  const oldPath = doc.path;
  let path = doc.path;
  if (saveAs || path === null) {
    path = await saveDialog({ defaultPath: path ?? doc.title });
    if (path === null) return;
  }
  try {
    const result = await saveDocument({
      path,
      content: editor.content(),
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
    });
    recentSaves.set(path, Date.now());
    if (oldPath !== path) {
      if (oldPath) void unwatchFile(oldPath).catch(() => {});
      void watchFile(path).catch(() => {});
      rememberRecent(path);
    }
    const titleChanged = doc.title !== basename(path);
    doc.path = path;
    doc.title = basename(path);
    doc.dirty = false;
    // Mixed line endings are written out as LF by the core.
    if (doc.lineEnding === "Mixed") doc.lineEnding = "LF";
    tabs.render();
    updateStatusBar(doc);
    updateWindowTitle();
    if (titleChanged) {
      void editor.setLanguage(doc.title, () => tabs.activeId === doc.id);
    }
    persistSession();
    if (result.unmappable) {
      await messageDialog(
        `Some characters could not be represented in ${doc.encoding} and were replaced.`,
        { title: "Encoding warning", kind: "warning" },
      );
    }
  } catch (error) {
    await messageDialog(String(error), { title: "Save failed", kind: "error" });
  }
}

/** Re-decode the file on disk with a user-chosen encoding. */
async function reopenWithEncoding(encoding: string): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path) return;
  if (doc.dirty) {
    const discard = await confirmDialog(
      `Reopening will discard unsaved changes in "${doc.title}". Continue?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Reopen" },
    );
    if (!discard) return;
  }
  try {
    const opened = await openDocument(doc.path, encoding);
    doc.encoding = opened.encoding;
    doc.withBom = opened.hadBom;
    doc.lineEnding = opened.lineEnding;
    doc.malformed = opened.malformed;
    doc.dirty = false;
    doc.truncated = opened.truncated;
    doc.totalSize = opened.totalSize;
    doc.buffer = editor.newBuffer(opened.content, opened.truncated);
    showActive();
    persistSession();
  } catch (error) {
    await messageDialog(String(error), {
      title: "Reopen failed",
      kind: "error",
    });
  }
}

function setLineEnding(lineEnding: string): void {
  const doc = tabs.active;
  if (!doc || doc.lineEnding === lineEnding) return;
  doc.lineEnding = lineEnding;
  if (!doc.dirty) {
    doc.dirty = true;
    tabs.render();
  }
  updateStatusBar(doc);
}

function showEncodingMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: "Reopen with Encoding",
      disabled: doc.path === null,
      action: () =>
        showMenu(
          anchor,
          REOPEN_ENCODINGS.map((e) => ({
            label: e.label,
            checked: e.value === doc.encoding,
            action: () => void reopenWithEncoding(e.value),
          })),
        ),
    },
    {
      label: "Save with Encoding",
      action: () =>
        showMenu(
          anchor,
          ENCODINGS.map((e) => ({
            label: e.label,
            checked: e.value === doc.encoding && e.withBom === doc.withBom,
            action: () => {
              doc.encoding = e.value;
              doc.withBom = e.withBom;
              updateStatusBar(doc);
              void saveFlow(false);
            },
          })),
        ),
    },
  ]);
}

function showLineEndingMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: "LF (Unix / macOS)",
      checked: doc.lineEnding === "LF",
      action: () => setLineEnding("LF"),
    },
    {
      label: "CRLF (Windows)",
      checked: doc.lineEnding === "CRLF",
      action: () => setLineEnding("CRLF"),
    },
  ]);
}

async function closeTab(id: number): Promise<void> {
  const doc = tabs.get(id);
  if (!doc) return;
  if (doc.dirty) {
    const discard = await confirmDialog(
      `"${doc.title}" has unsaved changes. Discard them?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Discard" },
    );
    if (!discard) return;
  }
  if (doc.path) void unwatchFile(doc.path).catch(() => {});
  const wasActive = id === tabs.activeId;
  tabs.close(id);
  if (tabs.docs.length === 0) tabs.add(makeUntitled());
  if (wasActive) showActive();
  else tabs.render();
  persistSession();
}

// File shortcuts (Mod-T/O/S/W) are owned by the native menu accelerators —
// binding them here as well would double-fire. Only tab cycling stays in
// the WebView because Ctrl+Tab is not reliable as a menu accelerator.
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  }
});

void listen<string>("plume://menu", (event) => {
  switch (event.payload) {
    case "new_tab":
      newTab();
      break;
    case "open":
      void openFileFlow();
      break;
    case "save":
      void saveFlow(false);
      break;
    case "save_as":
      void saveFlow(true);
      break;
    case "close_tab":
      if (tabs.activeId !== null) void closeTab(tabs.activeId);
      break;
    case "find":
      editor.openSearch();
      break;
    case "preferences":
      showPreferencesDialog();
      break;
    case "open_recent":
      showQuickOpen(recentFiles, (path) => void openPath(path));
      break;
    case "find_in_files":
      showFindInFiles((path, line) => {
        void openPath(path).then(() => editor.goToLine(line));
      });
      break;
    case "goto_line":
      showGoToLine((line) => editor.goToLine(line));
      break;
  }
});

void getCurrentWindow().onCloseRequested(async (event) => {
  const dirtyCount = tabs.docs.filter((d) => d.dirty).length;
  if (dirtyCount === 0) return;
  const discard = await confirmDialog(
    dirtyCount === 1
      ? "1 file has unsaved changes. Discard and quit?"
      : `${dirtyCount} files have unsaved changes. Discard and quit?`,
    { title: "Unsaved changes", kind: "warning", okLabel: "Discard" },
  );
  if (!discard) event.preventDefault();
});

document
  .querySelector<HTMLElement>("#status-encoding")!
  .addEventListener("click", (event) =>
    showEncodingMenu(event.currentTarget as HTMLElement),
  );
document
  .querySelector<HTMLElement>("#status-line-ending")!
  .addEventListener("click", (event) =>
    showLineEndingMenu(event.currentTarget as HTMLElement),
  );

/** Reopen the files from the previous session; missing files are skipped. */
async function restoreSession(): Promise<void> {
  const session = await loadSession().catch(() => null);
  for (const file of session?.files ?? []) {
    try {
      const opened = await openDocument(file.path, file.encoding);
      tabs.add(docFromOpened(opened));
    } catch {
      // The file may have been moved or deleted since last session.
    }
  }
  if (tabs.docs.length === 0) {
    tabs.add(makeUntitled());
  } else {
    const index = Math.min(session?.active ?? 0, tabs.docs.length - 1);
    tabs.setActive(tabs.docs[index].id);
  }
  showActive();
}

// Files opened through the OS while the app is already running.
void listen<string[]>("plume://open-files", async (event) => {
  for (const path of event.payload) {
    await openPath(path);
  }
});

// Files dragged from the system onto the window.
void getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop") return;
  for (const path of event.payload.paths) {
    await openPath(path);
  }
});

// Watched files that changed on disk outside of Plume.
void listen<string[]>("plume://file-changed", async (event) => {
  for (const path of event.payload) {
    await handleExternalChange(path);
  }
});

void (async () => {
  // Preferences first: the untitled fallback uses the default encoding.
  await initPreferences(editor);
  recentFiles = await loadRecentFiles().catch(() => [] as string[]);
  await restoreSession();
  // Files that triggered this launch open last so they end up focused.
  const pending = await takePendingFiles().catch(() => [] as string[]);
  for (const path of pending) {
    await openPath(path);
  }
})();
