import type { WindowChunk } from "./chunkwindow";
import type { EditorBuffer } from "./editor";
import { t } from "./i18n";
import type { LineIndex } from "./ipc";

export interface Doc {
  id: number;
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
  dirty: boolean;
  /** Read-only preview of a large file; saving is disabled. */
  truncated: boolean;
  totalSize: number;
  /** Paging state for truncated docs (line-aligned chunk offsets). */
  chunkOffset: number;
  nextChunkOffset: number | null;
  prevChunkOffsets: number[];
  /** Chunks currently in the buffer (sliding window, char+byte lengths). */
  windowChunks: WindowChunk[];
  /** Sparse line-offset index for go-to-line/bookmarks beyond the loaded
   *  window (truncated docs only). Null until built on first use, and
   *  invalidated back to null on reload/reopen or once its `indexedSize`
   *  no longer matches `totalSize` (see main.ts `ensureLineIndex`). */
  lineIndex: LineIndex | null;
  /** Absolute (1-based) file line number of the loaded window's own first
   *  line. Known only right after an index-driven goto jump (where it is
   *  computed for free); invalidated to null by anything that shifts the
   *  window without tracking the shift (pageChunk, continuous
   *  append/prepend) — this build deliberately does not carry a running
   *  delta through those paths. While null, bookmarks can't be placed and
   *  the gutter can't show them for this doc; the status bar's cursor
   *  position is still only ever the buffer-relative line. */
  windowStartLine: number | null;
  /** Bookmarked absolute (1-based) line numbers, sorted ascending. Small
   *  (non-truncated) docs use these directly as buffer line numbers.
   *  Session-local only — never persisted (see ROADMAP.md Track B). */
  bookmarks: number[];
  /** Hot-exit backup file name once unsaved content has been flushed. */
  backupName: string | null;
  /** Opaque metadata snapshot of the on-disk file as of the last open,
   *  reload, or successful save (see src-tauri/src/fsguard.rs) — passed
   *  back unexamined as `save_document`'s `expectedFingerprint` so a
   *  commit-time mismatch (someone else wrote to this path since) fails
   *  closed instead of silently overwriting the newer content (issue
   *  #113). `null` when there is no verified on-disk baseline yet: an
   *  untitled document, or one restored from a hot-exit backup without
   *  having been re-read from disk this session. */
  fingerprint: unknown;
  buffer: EditorBuffer;
}

export interface TabEvents {
  onSelect(id: number): void;
  onClose(id: number): void;
  onNew(): void;
}

export class TabStore {
  docs: Doc[] = [];
  activeId: number | null = null;

  constructor(
    private container: HTMLElement,
    private events: TabEvents,
  ) {}

  get active(): Doc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  get(id: number): Doc | null {
    return this.docs.find((d) => d.id === id) ?? null;
  }

  findByPath(path: string): Doc | null {
    return this.docs.find((d) => d.path === path) ?? null;
  }

  add(doc: Doc): void {
    this.docs.push(doc);
    this.activeId = doc.id;
  }

  setActive(id: number): void {
    if (this.get(id)) this.activeId = id;
  }

  /** Remove a tab. If it was active, a neighbor becomes active. */
  close(id: number): void {
    const index = this.docs.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.docs.splice(index, 1);
    if (this.activeId === id) {
      const neighbor = this.docs[index] ?? this.docs[index - 1];
      this.activeId = neighbor?.id ?? null;
    }
  }

  /** Move activation by offset (+1 next, -1 previous), wrapping around. */
  cycle(offset: number): void {
    if (this.docs.length < 2 || this.activeId === null) return;
    const index = this.docs.findIndex((d) => d.id === this.activeId);
    const next = (index + offset + this.docs.length) % this.docs.length;
    this.activeId = this.docs[next].id;
  }

  render(): void {
    this.container.replaceChildren();
    for (const doc of this.docs) {
      const tab = document.createElement("div");
      tab.className = doc.id === this.activeId ? "tab active" : "tab";
      tab.addEventListener("mousedown", () => this.events.onSelect(doc.id));

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = doc.title;
      if (doc.path) tab.title = doc.path;
      tab.appendChild(title);

      const close = document.createElement("button");
      close.className = doc.dirty ? "tab-close dirty" : "tab-close";
      close.textContent = doc.dirty ? "●" : "×";
      close.ariaLabel = t("tabs.closeAria", doc.title);
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      close.addEventListener("click", () => this.events.onClose(doc.id));
      tab.appendChild(close);

      this.container.appendChild(tab);
    }

    const add = document.createElement("button");
    add.className = "tab-new";
    add.textContent = "+";
    add.ariaLabel = t("tabs.newTabAria");
    add.addEventListener("click", () => this.events.onNew());
    this.container.appendChild(add);
  }
}
