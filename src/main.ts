import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as confirmDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { contentOf, createEditor, cursorOf, isEmptyBuffer } from "./editor";
import { encodingChoices, reopenEncodingChoices } from "./encodings";
import { onLocaleChange, t } from "./i18n";
import {
  addRecentFile,
  deleteBackup,
  loadBackup,
  loadRecentFiles,
  loadSession,
  openDocument,
  printWindow,
  readDocumentChunk,
  readDocumentChunkBefore,
  reportStartupReady,
  saveBackup,
  saveDocument,
  saveSession,
  takePendingFiles,
  unwatchFile,
  watchFile,
  type OpenedDocument,
  type SessionData,
  type SessionFile,
} from "./ipc";
import { canAutoAppend, canPrepend } from "./chunkpolicy";
import { lookupExtensionEncoding } from "./extensionEncodings";
import { pushBack, pushFront } from "./chunkwindow";
import { showCloseConfirm } from "./confirm";
import { showDetectionCard } from "./detectcard";
import { showFindInFiles } from "./findinfiles";
import { showGoToLine } from "./goto";
import { showHexView } from "./hexview";
import { showQuickOpen } from "./quickopen";
import { showMenu } from "./popup";
import {
  adjustFontSize,
  initPreferences,
  preferences,
  setTheme,
  showPreferencesDialog,
  toggleShowInvisibles,
  toggleWordWrap,
} from "./preferences";
import {
  refreshCursor,
  refreshStatusBar,
  updateCursor,
  updatePager,
  updateStatusBar,
} from "./statusbar";
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
    // Programmatic chunk appends must not mark read-only previews dirty.
    if (doc && !doc.truncated) {
      if (!doc.dirty) {
        doc.dirty = true;
        tabs.render();
        updateWindowTitle();
      }
      scheduleBackup();
    }
  },
  updateCursor,
  () => void autoAppendChunk(),
  () => void prependChunk(),
);

// ---- Hot exit: unsaved buffers are continuously backed up so closing the
// window never needs to ask about unsaved changes.

const BACKUP_DEBOUNCE_MS = 2000;
let backupTimer: number | null = null;

function backupNameFor(doc: Doc): string {
  if (!doc.backupName) doc.backupName = `bk-${doc.id}-${Date.now()}.txt`;
  return doc.backupName;
}

async function flushBackup(doc: Doc, content: string): Promise<void> {
  try {
    await saveBackup(backupNameFor(doc), content);
  } catch {
    // Best-effort; worst case the close-time flush retries.
  }
}

function scheduleBackup(): void {
  if (backupTimer !== null) window.clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    backupTimer = null;
    const doc = tabs.active;
    if (doc?.dirty && !doc.truncated) {
      void flushBackup(doc, editor.content()).then(persistSession);
    }
  }, BACKUP_DEBOUNCE_MS);
}

function dropBackup(doc: Doc): void {
  if (doc.backupName) {
    void deleteBackup(doc.backupName).catch(() => {});
    doc.backupName = null;
  }
}

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
    title:
      untitledCounter === 1
        ? t("app.untitled")
        : t("app.untitledNumbered", untitledCounter),
    encoding: preferences().defaultEncoding,
    withBom: preferences().defaultBom,
    lineEnding: defaultLineEnding,
    malformed: false,
    dirty: false,
    truncated: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    backupName: null,
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
  updatePager(pagerState(doc));
  updateWindowTitle();
  editor.focus();
  // No syntax highlighting for large-file windows: parsing tens of MB
  // (and re-parsing on every append) would stall the WebView.
  void editor.setLanguage(
    doc.truncated ? null : doc.title,
    () => tabs.activeId === doc.id,
  );
}

function collectSession(): SessionData {
  const sessionDocs = tabs.docs.filter(
    (d) => d.path !== null || (d.dirty && d.backupName !== null),
  );
  const files: SessionFile[] = sessionDocs.map((d) => ({
    path: d.path,
    encoding: d.encoding,
    cursor: cursorOf(d.id === tabs.activeId ? editor.snapshot() : d.buffer),
    backup: d.dirty ? d.backupName : null,
    title: d.title,
    withBom: d.withBom,
    lineEnding: d.lineEnding,
  }));
  const active = sessionDocs.findIndex((d) => d.id === tabs.activeId);
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
  if (current) {
    current.buffer = editor.snapshot();
    // Flush a pending backup before the editor switches away.
    if (backupTimer !== null && current.dirty && !current.truncated) {
      window.clearTimeout(backupTimer);
      backupTimer = null;
      void flushBackup(current, contentOf(current.buffer));
    }
  }
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

function docFromOpened(opened: OpenedDocument, cursor = 0): Doc {
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
    chunkOffset: 0,
    nextChunkOffset: opened.nextOffset,
    prevChunkOffsets: [],
    windowChunks: opened.truncated
      ? [
          {
            chars: opened.content.length,
            bytes: opened.nextOffset ?? opened.totalSize,
          },
        ]
      : [],
    backupName: null,
    buffer: editor.newBuffer(opened.content, opened.truncated, cursor),
  };
}

/** UTF-16 chunks cannot be line-aligned; paging is disabled for them. */
function pagingSupported(doc: Doc): boolean {
  return doc.truncated && !doc.encoding.startsWith("UTF-16");
}

function pagerState(doc: Doc): { hasPrev: boolean; hasNext: boolean } | null {
  if (!pagingSupported(doc)) return null;
  return {
    hasPrev: doc.prevChunkOffsets.length > 0,
    hasNext: doc.nextChunkOffset !== null,
  };
}

async function pageChunk(direction: 1 | -1): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  let target: number;
  if (direction === 1) {
    if (doc.nextChunkOffset === null) return;
    target = doc.nextChunkOffset;
  } else {
    const prev = doc.prevChunkOffsets.pop();
    if (prev === undefined) return;
    target = prev;
  }
  try {
    const chunkData = await readDocumentChunk(doc.path, target, doc.encoding);
    if (direction === 1) doc.prevChunkOffsets.push(doc.chunkOffset);
    doc.chunkOffset = chunkData.offset;
    doc.nextChunkOffset = chunkData.nextOffset;
    doc.malformed = chunkData.malformed;
    doc.windowChunks = [
      {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      },
    ];
    doc.buffer = editor.newBuffer(chunkData.content, true);
    showActive();
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.pagingTitle"),
      kind: "warning",
    });
  }
}

let chunkLoadInFlight = false;

/** Scrolling near the end of a large-file window loads the next chunk. */
async function autoAppendChunk(): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  if (
    !canAutoAppend({
      nextOffset: doc.nextChunkOffset,
      inFlight: chunkLoadInFlight,
    })
  ) {
    return;
  }
  chunkLoadInFlight = true;
  try {
    const loadedAt = doc.nextChunkOffset!;
    const chunkData = await readDocumentChunk(doc.path, loadedAt, doc.encoding);
    // The user may have switched tabs while the chunk was loading.
    if (tabs.activeId === doc.id) {
      editor.appendText(chunkData.content);
      doc.nextChunkOffset = chunkData.nextOffset;
      const trim = pushBack(doc.windowChunks, {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      });
      if (trim) {
        editor.trimStart(trim.trimChars);
        doc.chunkOffset += trim.trimBytes;
      }
      doc.buffer = editor.snapshot();
      updatePager(pagerState(doc));
    }
  } catch {
    // Transient read failure; the manual pager remains available.
  } finally {
    chunkLoadInFlight = false;
  }
}

/** Scrolling near the top of a mid-file window loads the previous chunk. */
async function prependChunk(): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  if (
    !canPrepend({
      windowStart: doc.chunkOffset,
      inFlight: chunkLoadInFlight,
    })
  ) {
    return;
  }
  chunkLoadInFlight = true;
  try {
    const windowStart = doc.chunkOffset;
    const chunkData = await readDocumentChunkBefore(
      doc.path,
      windowStart,
      doc.encoding,
    );
    // The user may have switched tabs while the chunk was loading.
    if (tabs.activeId === doc.id) {
      editor.prependText(chunkData.content);
      doc.chunkOffset = chunkData.offset;
      const trim = pushFront(doc.windowChunks, {
        chars: chunkData.content.length,
        bytes: windowStart - chunkData.offset,
      });
      if (trim) {
        editor.trimEnd(trim.trimChars);
        doc.nextChunkOffset =
          (doc.nextChunkOffset ?? chunkData.totalSize) - trim.trimBytes;
      }
      doc.buffer = editor.snapshot();
      updatePager(pagerState(doc));
    }
  } catch {
    // Transient read failure; the manual pager remains available.
  } finally {
    chunkLoadInFlight = false;
  }
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
    doc.chunkOffset = 0;
    doc.nextChunkOffset = opened.nextOffset;
    doc.prevChunkOffsets = [];
    doc.windowChunks = opened.truncated
      ? [
          {
            chars: opened.content.length,
            bytes: opened.nextOffset ?? opened.totalSize,
          },
        ]
      : [];
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
    const reload = await confirmDialog(t("dialog.fileChangedMessage", doc.title), {
      title: t("dialog.fileChangedTitle"),
      kind: "warning",
      okLabel: t("dialog.reload"),
    });
    if (reload) await reloadFromDisk(doc);
  } finally {
    reloadPrompts.delete(path);
  }
}

/** Per-extension default encoding for `path` from the preferences table,
 *  forwarded to the Rust core as an auto-detection hint. */
function extensionHint(path: string): string | undefined {
  return lookupExtensionEncoding(preferences().extensionEncodings, path);
}

/** Open a file by path into a tab, focusing the existing tab if any. */
async function openPath(path: string): Promise<void> {
  const existing = tabs.findByPath(path);
  if (existing) {
    activate(existing.id);
    return;
  }
  try {
    const opened = await openDocument(path, undefined, extensionHint(path));
    const previous = tabs.active;
    if (previous) previous.buffer = editor.snapshot();
    tabs.add(docFromOpened(opened));
    if (previous && isPristineUntitled(previous)) tabs.close(previous.id);
    showActive();
    persistSession();
    rememberRecent(opened.path);
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.openFailedTitle"),
      kind: "error",
    });
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
    await messageDialog(t("dialog.readonlyPreviewMessage", doc.title), {
      title: t("dialog.readonlyPreviewTitle"),
      kind: "warning",
    });
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
    dropBackup(doc);
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
      await messageDialog(t("dialog.encodingWarningMessage", doc.encoding), {
        title: t("dialog.encodingWarningTitle"),
        kind: "warning",
      });
    }
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.saveFailedTitle"),
      kind: "error",
    });
  }
}

/** Re-decode the file on disk with a user-chosen encoding. */
async function reopenWithEncoding(encoding: string): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path) return;
  if (doc.dirty) {
    const discard = await confirmDialog(t("dialog.reopenMessage", doc.title), {
      title: t("dialog.unsavedChangesTitle"),
      kind: "warning",
      okLabel: t("dialog.reopen"),
    });
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
    doc.chunkOffset = 0;
    doc.nextChunkOffset = opened.nextOffset;
    doc.prevChunkOffsets = [];
    doc.windowChunks = opened.truncated
      ? [
          {
            chars: opened.content.length,
            bytes: opened.nextOffset ?? opened.totalSize,
          },
        ]
      : [];
    doc.buffer = editor.newBuffer(opened.content, opened.truncated);
    showActive();
    persistSession();
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.reopenFailedTitle"),
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
      label: t("menu.whyEncoding", doc.encoding),
      // Untitled documents have no file on disk to re-read and explain.
      disabled: doc.path === null,
      action: () => {
        if (doc.path) {
          showDetectionCard(
            anchor,
            doc.path,
            doc.title,
            doc.encoding,
            extensionHint(doc.path),
          );
        }
      },
    },
    {
      label: t("menu.reopenWithEncoding"),
      disabled: doc.path === null,
      action: () =>
        showMenu(
          anchor,
          reopenEncodingChoices().map((e) => ({
            label: e.label,
            checked: e.value === doc.encoding,
            action: () => void reopenWithEncoding(e.value),
          })),
        ),
    },
    {
      label: t("menu.saveWithEncoding"),
      action: () =>
        showMenu(
          anchor,
          encodingChoices().map((e) => ({
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

function showDecodeWarningMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: t("menu.viewRawBytes"),
      // Only real files have bytes on disk to inspect; untitled docs
      // cannot reach the malformed state in the first place, but this
      // stays defensive in case that ever changes.
      disabled: doc.path === null,
      action: () => {
        if (doc.path) showHexView(doc.path, doc.title);
      },
    },
  ]);
}

function showLineEndingMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: t("menu.lineEndingLf"),
      checked: doc.lineEnding === "LF",
      action: () => setLineEnding("LF"),
    },
    {
      label: t("menu.lineEndingCrlf"),
      checked: doc.lineEnding === "CRLF",
      action: () => setLineEnding("CRLF"),
    },
  ]);
}

async function closeTab(id: number): Promise<void> {
  const doc = tabs.get(id);
  if (!doc) return;
  if (doc.dirty) {
    const choice = await showCloseConfirm(doc.title);
    if (choice === "cancel") return;
    if (choice === "save") {
      // saveFlow operates on the active doc; activate the tab first.
      if (tabs.activeId !== id) activate(id);
      await saveFlow(false);
      // Save dialog cancelled (e.g. untitled doc): abort the close.
      if (doc.dirty) return;
    }
  }
  if (doc.path) void unwatchFile(doc.path).catch(() => {});
  dropBackup(doc);
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
    case "word_wrap":
      toggleWordWrap();
      break;
    case "show_invisibles":
      toggleShowInvisibles();
      break;
    case "zoom_in":
      adjustFontSize(1);
      break;
    case "zoom_out":
      adjustFontSize(-1);
      break;
    case "zoom_reset":
      adjustFontSize(0);
      break;
    case "find_in_files":
      showFindInFiles((path, line) => {
        void openPath(path).then(() => editor.goToLine(line));
      });
      break;
    case "goto_line":
      showGoToLine((line) => editor.goToLine(line));
      break;
    case "print": {
      // The editor's viewport only renders visible lines, so printing goes
      // through a print-only view holding the full document text.
      const printView = document.querySelector<HTMLElement>("#print-view")!;
      printView.textContent = editor.content();
      void printWindow()
        .catch((error) =>
          messageDialog(String(error), {
            title: t("dialog.printTitle"),
            kind: "warning",
          }),
        )
        .finally(() => {
          printView.textContent = "";
        });
      break;
    }
    default:
      // The View > Theme submenu emits "theme_<value>" for each of its
      // radio entries (menu.rs); route those without a case per value.
      if (event.payload.startsWith("theme_")) {
        setTheme(event.payload.slice("theme_".length));
      }
      break;
  }
});

// Hot exit: flush every unsaved buffer to its backup and quit without
// asking — the next launch restores everything, including untitled tabs.
void getCurrentWindow().onCloseRequested(async () => {
  if (backupTimer !== null) {
    window.clearTimeout(backupTimer);
    backupTimer = null;
  }
  for (const doc of tabs.docs) {
    if (!doc.dirty || doc.truncated) continue;
    const content =
      doc.id === tabs.activeId ? editor.content() : contentOf(doc.buffer);
    await flushBackup(doc, content);
  }
  await saveSession(collectSession()).catch(() => {});
});

document
  .querySelector<HTMLElement>("#chunk-prev")!
  .addEventListener("click", () => void pageChunk(-1));
document
  .querySelector<HTMLElement>("#chunk-next")!
  .addEventListener("click", () => void pageChunk(1));
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
document
  .querySelector<HTMLElement>("#status-warning")!
  .addEventListener("click", (event) =>
    showDecodeWarningMenu(event.currentTarget as HTMLElement),
  );

/** Keep new untitled numbering clear of titles restored from backups.
 *  Matches both untitled roots ("Untitled", "未命名") since a session or
 *  hot-exit backup created under one locale can be restored under another. */
function bumpUntitledCounter(title: string): void {
  for (const root of ["Untitled", "未命名"]) {
    const match = new RegExp(`^${root}(?:-(\\d+))?$`).exec(title);
    if (match) {
      untitledCounter = Math.max(
        untitledCounter,
        match[1] ? Number(match[1]) : 1,
      );
      return;
    }
  }
}

/** Restore one session entry from its hot-exit backup, if present. */
async function restoreFromBackup(file: SessionFile): Promise<boolean> {
  if (!file.backup) return false;
  const content = await loadBackup(file.backup).catch(() => null);
  if (content === null) return false;
  const title =
    file.title || (file.path ? basename(file.path) : t("app.untitled"));
  bumpUntitledCounter(title);
  tabs.add({
    id: nextId++,
    path: file.path,
    title,
    encoding: file.encoding,
    withBom: file.withBom ?? false,
    lineEnding: file.lineEnding || defaultLineEnding,
    malformed: false,
    dirty: true,
    truncated: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    backupName: file.backup,
    buffer: editor.newBuffer(content, false, file.cursor ?? 0),
  });
  if (file.path) void watchFile(file.path).catch(() => {});
  return true;
}

/** Reopen the files from the previous session; missing files are skipped. */
async function restoreSession(): Promise<void> {
  const session = await loadSession().catch(() => null);
  for (const file of session?.files ?? []) {
    try {
      if (await restoreFromBackup(file)) continue;
      if (file.path) {
        const opened = await openDocument(file.path, file.encoding);
        tabs.add(docFromOpened(opened, file.cursor ?? 0));
      }
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
  editor.revealCursor();
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

// Locale changes (from the Preferences dialog's Language select) update the
// frontend's own strings immediately; the native menu relabels itself
// separately (see preferences.ts applyLanguage / ipc.ts retitleMenu).
onLocaleChange(() => {
  tabs.render();
  refreshStatusBar();
  refreshCursor();
  updateWindowTitle();
});

void (async () => {
  // Preferences first: the untitled fallback uses the default encoding, and
  // the resolved locale needs to be applied before anything else renders.
  await initPreferences(editor);
  refreshStatusBar();
  refreshCursor();
  recentFiles = await loadRecentFiles().catch(() => [] as string[]);
  await restoreSession();
  // Files that triggered this launch open last so they end up focused.
  const pending = await takePendingFiles().catch(() => [] as string[]);
  for (const path of pending) {
    await openPath(path);
  }
  // Cold-start probe hook: no-op unless PLUME_STARTUP_PROBE=1 (see
  // scripts/startup-bench.mjs). Marks "frontend ready" for the benchmark.
  void reportStartupReady().catch(() => {});
})();
