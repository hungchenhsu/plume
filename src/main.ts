import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as confirmDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { contentOf, createEditor, cursorOf, isEmptyBuffer, lineCountOf } from "./editor";
import { encodingChoices, reopenEncodingChoices } from "./encodings";
import { onLocaleChange, t } from "./i18n";
import {
  addRecentFile,
  buildLineIndex,
  deleteBackup,
  listBackups,
  loadBackup,
  loadRecentFiles,
  loadSession,
  locateLineOffset,
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
  type LineIndex,
  type OpenedDocument,
  type SessionData,
  type SessionFile,
} from "./ipc";
import { showBatchConvert } from "./batchconvert";
import {
  nextBookmark,
  previousBookmark,
  toggleBookmark,
  windowRelativeBookmarks,
} from "./bookmarks";
import { canAutoAppend, canPrepend } from "./chunkpolicy";
import { showComparePreview } from "./comparepreview";
import { lookupExtensionEncoding } from "./extensionEncodings";
import { pushBack, pushFront } from "./chunkwindow";
import { showCloseConfirm } from "./confirm";
import { showDetectionCard } from "./detectcard";
import { showFindInFiles } from "./findinfiles";
import { showGoToLine } from "./goto";
import { showHexView } from "./hexview";
import { clampLine, selectCheckpoint } from "./lineindex";
import { lowerCase, sortLines, trimTrailingWhitespace, uniqueLines, upperCase } from "./lineops";
import { isMojibakeSnapshotStale, showMojibakeWizard } from "./mojibake";
import { orphanBackups } from "./orphans";
import { showQuickOpen } from "./quickopen";
import { showMenu } from "./popup";
import { showStreamReplace } from "./streamreplace";
import {
  adjustFontSize,
  initPreferences,
  preferences,
  setTheme,
  showPreferencesDialog,
  toggleIndentGuides,
  toggleShowInvisibles,
  toggleWordWrap,
} from "./preferences";
import {
  currentCursorLine,
  refreshCursor,
  refreshStatusBar,
  setIndexing,
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

/** Write one document's unsaved content to its hot-exit backup. Returns
 *  false instead of throwing on failure: mid-editing flushes stay
 *  best-effort, but the close handler must know — closing on a failed
 *  flush would silently lose the content hot exit promised to keep
 *  (issue #63). */
async function flushBackup(doc: Doc, content: string): Promise<boolean> {
  try {
    await saveBackup(backupNameFor(doc), content);
    return true;
  } catch {
    return false;
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
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
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
  syncBookmarkGutter();
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
    lineIndex: null,
    // Offset 0 is unambiguously line 1 — no scan needed to know this yet.
    windowStartLine: opened.truncated ? 1 : null,
    bookmarks: [],
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
    // The jump pager doesn't track how many lines it moved by, unlike
    // gotoLargeFileLine below (which computes this for free from the line
    // index) — see the windowStartLine trade-off note on tabs.ts Doc.
    doc.windowStartLine = null;
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
      // The window shifted without tracking by how many lines — clear
      // rather than show gutter marks at now-wrong positions.
      doc.windowStartLine = null;
      editor.setBookmarks([]);
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
      // The window shifted without tracking by how many lines — clear
      // rather than show gutter marks at now-wrong positions.
      doc.windowStartLine = null;
      editor.setBookmarks([]);
      doc.buffer = editor.snapshot();
      updatePager(pagerState(doc));
    }
  } catch {
    // Transient read failure; the manual pager remains available.
  } finally {
    chunkLoadInFlight = false;
  }
}

/**
 * Build (or reuse) `doc`'s line-offset index for go-to-line/bookmarks
 * beyond the loaded window. Staleness in practice rides on the file
 * watcher: every path that learns about an external change (reload,
 * reopen) also clears `lineIndex`, and nothing updates `totalSize` from
 * disk without doing so — the `indexedSize` comparison below is a cheap
 * internal-consistency guard, not an independent external-change
 * detector. A same-size overwrite that the best-effort watcher misses
 * can therefore leave a stale index; the chunk read's line-start
 * alignment self-corrects the jump target to a real line boundary, but
 * the reported line number can be off until the watcher catches up.
 * Returns null on failure or for a doc with no path to index; the
 * caller treats that as a no-op.
 */
async function ensureLineIndex(doc: Doc): Promise<LineIndex | null> {
  if (!doc.path) return null;
  if (doc.lineIndex && doc.lineIndex.indexedSize === doc.totalSize) {
    return doc.lineIndex;
  }
  setIndexing(true);
  try {
    const report = await buildLineIndex(doc.path, doc.encoding);
    doc.lineIndex = report;
    // Keep totalSize in lockstep with what was actually just scanned, so
    // the staleness check above compares against the index's own baseline
    // rather than a possibly-already-stale open-time size (which would
    // otherwise force a pointless rebuild on every subsequent call if the
    // file had already grown before this first build). Also keeps the
    // status bar's read-only-preview size fresh as a side benefit.
    doc.totalSize = report.indexedSize;
    return report;
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.lineIndexFailedTitle"),
      kind: "warning",
    });
    return null;
  } finally {
    setIndexing(false);
  }
}

/**
 * Large-file go-to-line: jump straight to `targetLine1` (1-based) via the
 * line-offset index, replacing the loaded window with a single fresh chunk
 * starting at that line — mirroring pageChunk's own single-chunk window
 * reset. Deliberately does *not* check whether the target already falls
 * inside the currently loaded window first (it always reloads): tracking
 * "how many lines does the loaded window currently span" would need line
 * counts threaded through chunkwindow.ts's WindowChunk bookkeeping (append
 * /prepend/trim all over pageChunk.ts's usage), which is real extra surface
 * in a byte/char/line-unit danger domain for what's a rare-ish operation.
 * The cost is one extra IPC round trip when the target was already
 * visible — see the PR description for the full trade-off.
 */
async function gotoLargeFileLine(doc: Doc, targetLine1: number): Promise<void> {
  if (!doc.path) return;
  const index = await ensureLineIndex(doc);
  if (!index || index.totalLines === 0) return;
  const target0 = clampLine(targetLine1 - 1, index.totalLines);
  const checkpoint = selectCheckpoint(index.checkpoints, target0);
  try {
    const offset =
      target0 === checkpoint.line
        ? checkpoint.offset
        : await locateLineOffset(doc.path, target0, checkpoint.offset, checkpoint.line);
    const chunkData = await readDocumentChunk(doc.path, offset, doc.encoding);
    doc.chunkOffset = chunkData.offset;
    doc.nextChunkOffset = chunkData.nextOffset;
    doc.prevChunkOffsets = [];
    doc.malformed = chunkData.malformed;
    doc.windowChunks = [
      {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      },
    ];
    doc.buffer = editor.newBuffer(chunkData.content, true);
    doc.windowStartLine = target0 + 1;
    showActive();
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.pagingTitle"),
      kind: "warning",
    });
  }
}

/** Mod+L / Edit > Go to Line: within the loaded window for a regular
 *  document (or a large-file doc whose paging is unsupported, e.g.
 *  UTF-16 — see pagingSupported), just move the cursor; otherwise jump via
 *  the line-offset index. */
function handleGotoLine(line: number): void {
  const doc = tabs.active;
  if (!doc) return;
  if (!pagingSupported(doc)) {
    editor.goToLine(line);
    return;
  }
  void gotoLargeFileLine(doc, line);
}

/** Refresh the gutter's bookmark dots for whatever's currently on screen.
 *  Small docs map 1:1 (doc.bookmarks are already buffer line numbers);
 *  large docs need windowStartLine to translate absolute -> buffer-relative,
 *  and show nothing when it's unknown (see tabs.ts Doc.windowStartLine). */
function syncBookmarkGutter(): void {
  const doc = tabs.active;
  if (!doc) return;
  if (!doc.truncated) {
    editor.setBookmarks(doc.bookmarks);
    return;
  }
  editor.setBookmarks(
    windowRelativeBookmarks(doc.bookmarks, doc.windowStartLine, lineCountOf(editor.snapshot())),
  );
}

/** The absolute (1-based) file line the cursor is currently on, or null if
 *  that can't be determined right now (large file, window position
 *  unknown — see tabs.ts Doc.windowStartLine). */
function currentAbsoluteLine(doc: Doc): number | null {
  const bufferLine = currentCursorLine();
  if (!doc.truncated) return bufferLine;
  if (doc.windowStartLine === null) return null;
  return doc.windowStartLine + bufferLine - 1;
}

function jumpToBookmark(doc: Doc, target: number | null): void {
  if (target === null) return;
  if (!doc.truncated) {
    editor.goToLine(target);
    return;
  }
  void gotoLargeFileLine(doc, target);
}

/**
 * Edit > Toggle Bookmark. For a large file whose window position isn't
 * currently known (windowStartLine null — nothing has anchored it since
 * the last append/prepend/pageChunk jump), bookmarking the current line
 * can't be done safely, so this asks the user to Go to Line first rather
 * than silently bookmarking the wrong line or guessing.
 */
function toggleBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const line = currentAbsoluteLine(doc);
  if (line === null) {
    void messageDialog(t("dialog.bookmarkNeedsGotoMessage"), {
      title: t("dialog.bookmarkNeedsGotoTitle"),
      kind: "info",
    });
    return;
  }
  doc.bookmarks = toggleBookmark(doc.bookmarks, line);
  syncBookmarkGutter();
}

/** Edit > Next/Previous Bookmark. When the current line can't be
 *  determined (see currentAbsoluteLine), Next starts from "before
 *  everything" (jumps to the first bookmark) and Previous starts from
 *  "after everything" (jumps to the last) — a reasonable default when
 *  there's no current position to search relative to. */
function nextBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const current = currentAbsoluteLine(doc) ?? 0;
  jumpToBookmark(doc, nextBookmark(doc.bookmarks, current));
}

function previousBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const current = currentAbsoluteLine(doc) ?? Number.MAX_SAFE_INTEGER;
  jumpToBookmark(doc, previousBookmark(doc.bookmarks, current));
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
    // The file on disk changed, so any prior index is potentially stale —
    // ensureLineIndex would also catch a size mismatch, but reload always
    // rebuilds from scratch (offset 0) so there's nothing to salvage anyway.
    doc.lineIndex = null;
    doc.windowStartLine = opened.truncated ? 1 : null;
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

/** Save the active document. Resolves to true only when bytes actually
 *  reached the disk — callers that speculatively changed doc state (e.g.
 *  the save-with-encoding menu) roll back on false. */
async function saveFlow(saveAs: boolean): Promise<boolean> {
  const doc = tabs.active;
  if (!doc) return false;
  if (doc.truncated) {
    // Writing the preview slice back would destroy the rest of the file.
    await messageDialog(t("dialog.readonlyPreviewMessage", doc.title), {
      title: t("dialog.readonlyPreviewTitle"),
      kind: "warning",
    });
    return false;
  }
  const oldPath = doc.path;
  let path = doc.path;
  if (saveAs || path === null) {
    path = await saveDialog({ defaultPath: path ?? doc.title });
    if (path === null) return false;
  }
  try {
    const content = editor.content();
    const saveParams = {
      path,
      content,
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
    };
    let result = await saveDocument({ ...saveParams, allowLossy: false });
    if (result.unmappable && !result.written) {
      const proceed = await confirmDialog(
        t("dialog.lossyEncodingMessage", doc.encoding),
        {
          title: t("dialog.lossyEncodingTitle"),
          kind: "warning",
          okLabel: t("dialog.lossyEncodingConfirm"),
        },
      );
      // Cancelled: the doc stays exactly as it was before Save was
      // invoked — dirty, on its old path, no watcher/session changes.
      if (!proceed) return false;
      result = await saveDocument({ ...saveParams, allowLossy: true });
    }
    // Only once the bytes are actually on disk do we touch doc state or
    // run any of the success side effects below.
    if (!result.written) return false;
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
    return true;
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.saveFailedTitle"),
      kind: "error",
    });
    return false;
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
    // A changed encoding can flip UTF-16 support on/off (see pagingSupported)
    // and, symmetrically with reloadFromDisk, restarts the window at offset
    // 0 anyway, so any prior index is discarded rather than re-validated.
    doc.lineIndex = null;
    doc.windowStartLine = opened.truncated ? 1 : null;
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

/**
 * Open the mojibake repair wizard for the active document's live editor
 * content. No-op if there is no active tab or it is a read-only large-file
 * preview (repair can't act on the whole document there — see
 * ARCHITECTURE.md's large-file phase 1). Guards against two ways the live
 * document can move on while the (async) wizard sits open — detection and
 * the user's candidate pick both take a round trip:
 *
 * - The active tab changes: if the user switches tabs in the meantime,
 *   applying the repair to whatever is now live in the editor would
 *   silently corrupt an unrelated document. Checked via `tabs.activeId`
 *   and resolved silently (no dialog) — the user isn't looking at this
 *   document anymore, so there's nothing useful to tell them.
 * - The *same* tab is edited: typing, a line operation, or a reload can
 *   all change the buffer without switching tabs. The repair in hand was
 *   computed from `snapshot`, the content at the moment the wizard opened
 *   (see `isMojibakeSnapshotStale` in mojibake.ts) — applying it now would
 *   silently overwrite the user's newer edits with a rebuild of stale
 *   content (issue #93). Since the user is still on this tab, this case
 *   surfaces a dialog rather than failing silently.
 */
function showMojibakeRepairWizard(): void {
  const doc = tabs.active;
  if (!doc || doc.truncated) return;
  const docId = doc.id;
  const snapshot = editor.content();
  showMojibakeWizard(snapshot, (repaired) => {
    if (tabs.activeId !== docId) return;
    if (isMojibakeSnapshotStale(snapshot, editor.content())) {
      void messageDialog(t("mojibake.staleContentMessage"), {
        title: t("mojibake.staleContentTitle"),
        kind: "warning",
      });
      return;
    }
    editor.replaceContent(repaired);
  });
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
      label: t("menu.compareEncodings"),
      // Read-only side-by-side preview needs a file on disk to re-read;
      // an untitled document has none (mirrors the other doc.path === null
      // guards in this menu).
      disabled: doc.path === null,
      action: () => {
        if (doc.path) {
          showComparePreview(doc.path, doc.encoding, (encoding) =>
            void reopenWithEncoding(encoding),
          );
        }
      },
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
              // Applied speculatively so the save encodes with the new
              // choice; rolled back if nothing was written (lossy save
              // declined, dialog cancelled, or write failure) so a
              // "clean" doc never shows an encoding the disk doesn't have.
              const prevEncoding = doc.encoding;
              const prevWithBom = doc.withBom;
              doc.encoding = e.value;
              doc.withBom = e.withBom;
              updateStatusBar(doc);
              void saveFlow(false).then((written) => {
                if (!written) {
                  doc.encoding = prevEncoding;
                  doc.withBom = prevWithBom;
                  updateStatusBar(doc);
                }
              });
            },
          })),
        ),
    },
    {
      label: t("menu.repairMojibake"),
      // Mojibake is "legal but wrong" text, not a decode error, so this
      // entry doesn't depend on doc.malformed — see showDecodeWarningMenu
      // for the other entry point. Large-file previews are read-only.
      disabled: doc.truncated,
      action: () => showMojibakeRepairWizard(),
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
    {
      label: t("menu.repairMojibake"),
      disabled: doc.truncated,
      action: () => showMojibakeRepairWizard(),
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
    {
      label: t("menu.lineEndingCr"),
      checked: doc.lineEnding === "CR",
      action: () => setLineEnding("CR"),
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

/** Guard an Edit > Line Operations menu action against a truncated
 *  (read-only, large-file preview) document, then run it — reuses
 *  saveFlow's readonly-preview dialog and i18n strings, since transforming
 *  a preview slice would silently diverge from the file on disk with no
 *  way to save the result back. */
function runLineOperation(action: () => void): void {
  const doc = tabs.active;
  if (!doc) return;
  if (doc.truncated) {
    void messageDialog(t("dialog.readonlyPreviewMessage", doc.title), {
      title: t("dialog.readonlyPreviewTitle"),
      kind: "warning",
    });
    return;
  }
  action();
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
    case "indent_guides":
      toggleIndentGuides();
      break;
    case "fold_all":
      editor.foldAll();
      break;
    case "unfold_all":
      editor.unfoldAll();
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
      showGoToLine((line) => handleGotoLine(line));
      break;
    case "toggle_bookmark":
      toggleBookmarkFlow();
      break;
    case "next_bookmark":
      nextBookmarkFlow();
      break;
    case "prev_bookmark":
      previousBookmarkFlow();
      break;
    case "sort_lines":
      runLineOperation(() => editor.transformLines(sortLines));
      break;
    case "unique_lines":
      runLineOperation(() => editor.transformLines(uniqueLines));
      break;
    case "trim_trailing_whitespace":
      runLineOperation(() => editor.transformLines(trimTrailingWhitespace));
      break;
    case "move_line_up":
      runLineOperation(() => editor.moveLineUp());
      break;
    case "move_line_down":
      runLineOperation(() => editor.moveLineDown());
      break;
    case "duplicate_line":
      runLineOperation(() => editor.duplicateLine());
      break;
    case "delete_line":
      runLineOperation(() => editor.deleteLine());
      break;
    case "uppercase":
      runLineOperation(() => editor.transformSelection(upperCase));
      break;
    case "lowercase":
      runLineOperation(() => editor.transformSelection(lowerCase));
      break;
    case "batch_convert":
      showBatchConvert();
      break;
    case "stream_replace": {
      const doc = tabs.active;
      if (!doc) break;
      if (!doc.truncated) {
        // The regular in-editor Find/Replace (Mod+F) already covers this
        // document in full; streaming replace exists only for read-only
        // large-file previews, where only a slice of the file is loaded.
        void messageDialog(t("dialog.streamReplaceUseRegularMessage"), {
          title: t("dialog.streamReplaceUseRegularTitle"),
          kind: "info",
        });
        break;
      }
      if (doc.path) {
        showStreamReplace(doc.path, doc.encoding, () => void reloadFromDisk(doc));
      }
      break;
    }
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
// If any backup cannot be written (disk full, unwritable config dir),
// closing would silently break that promise, so the window stays open
// and the user chooses: fix the problem, or discard knowingly (#63).
void getCurrentWindow().onCloseRequested(async (event) => {
  if (backupTimer !== null) {
    window.clearTimeout(backupTimer);
    backupTimer = null;
  }
  const failedTitles: string[] = [];
  for (const doc of tabs.docs) {
    if (!doc.dirty || doc.truncated) continue;
    const content =
      doc.id === tabs.activeId ? editor.content() : contentOf(doc.buffer);
    if (!(await flushBackup(doc, content))) failedTitles.push(doc.title);
  }
  if (failedTitles.length > 0) {
    event.preventDefault();
    // A rejected dialog counts as cancel — staying open is the safe side.
    const discard = await confirmDialog(
      t("dialog.backupFailedMessage", failedTitles),
      {
        title: t("dialog.backupFailedTitle"),
        kind: "warning",
        okLabel: t("dialog.backupFailedDiscard"),
      },
    ).catch(() => false);
    if (discard) {
      // Deliberately keep any backup a *previous* flush wrote, and keep
      // the session referencing it: the next launch may resurrect an
      // older version of these docs as dirty tabs. Losing only the very
      // last edits the user just gave up on — instead of deleting the
      // older backup too — errs on the keep-more side.
      await saveSession(collectSession()).catch(() => {});
      // destroy() closes without re-emitting a close request.
      void getCurrentWindow().destroy();
    }
    return;
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
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
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
  // Recover backups the session index doesn't account for: either the
  // index itself is missing/corrupt (issue #62), or it's merely stale (a
  // backup landed on disk without ever being recorded, or its entry was
  // dropped, before the backup file itself was removed). Each orphan
  // becomes its own untitled tab. This can occasionally resurrect a stale
  // leftover from a failed delete_backup as a spurious extra tab, but that
  // cost is far cheaper than silently losing unsaved content.
  const all = await listBackups().catch(() => [] as string[]);
  const orphans = orphanBackups(
    session?.files.map((f) => f.backup) ?? [],
    all,
  );
  for (const name of orphans) {
    const content = await loadBackup(name).catch(() => null);
    if (content === null) continue;
    untitledCounter += 1;
    const title =
      untitledCounter === 1
        ? t("app.untitled")
        : t("app.untitledNumbered", untitledCounter);
    tabs.add({
      id: nextId++,
      path: null,
      title,
      encoding: preferences().defaultEncoding,
      withBom: preferences().defaultBom,
      lineEnding: defaultLineEnding,
      malformed: false,
      dirty: true,
      truncated: false,
      totalSize: 0,
      chunkOffset: 0,
      nextChunkOffset: null,
      prevChunkOffsets: [],
      windowChunks: [],
      lineIndex: null,
      windowStartLine: null,
      bookmarks: [],
      backupName: name,
      buffer: editor.newBuffer(content, false, 0),
    });
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
