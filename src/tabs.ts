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
  /** Monotonically increasing counter drawn from a single app-wide sequence
   *  (never reset to a fixed 0), bumped on every editor doc-change and on
   *  open/reload/reopen (main.ts). A saveFlow snapshots this right before
   *  its IPC round trip; if it no longer matches once the save resolves,
   *  an edit landed while the write was in flight, so dirty/backup must
   *  survive the completion handler instead of being cleared (issue #112)
   *  — see savecompletion.ts. Drawing resets from the shared sequence
   *  rather than a fixed 0 means a stale snapshot can never spuriously
   *  match a post-reset value. */
  revision: number;
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
  /** Monotonically increasing per-doc counter (never reset), bumped by
   *  every chunk-window-mutating operation before issuing its IPC call(s)
   *  — Next/Prev paging, continuous-reading auto append/prepend, go-to-
   *  line/bookmark jump — and by reload-from-disk/reopen-with-encoding
   *  even though they have no chunk response of their own to gate, purely
   *  to invalidate whatever chunk request might still be in flight once
   *  they reset this doc's chunk-window state from scratch. A chunk
   *  response is only applied if it still matches this value once its IPC
   *  round trip resolves — see chunkguard.ts's shouldApplyChunkResponse
   *  (issue #120). */
  chunkGeneration: number;
  /** True while a chunk-window-mutating IPC call (any of the operations
   *  described on chunkGeneration above, except reload/reopen — which
   *  invalidate and clear this instead of waiting on it) is in flight for
   *  this doc. Serializes them so, say, a manual Next click and an
   *  in-progress continuous-reading auto-append never overlap for the
   *  same doc (issue #120). Per-doc rather than the single module-level
   *  flag this replaces, so an in-flight load in one tab no longer blocks
   *  unrelated auto-loading in another tab. */
  chunkLoadInFlight: boolean;
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
  /** Fired once, after a completed drag actually changes tab order (never
   *  for a plain click, and never for a drag that drops back on its start
   *  slot) — main.ts hooks this to persistSession(), mirroring the timing
   *  every other order-affecting tab operation already persists at. */
  onReorder(): void;
}

/** Horizontal pointer displacement, in CSS pixels, a tab must travel before
 *  a press-and-hold becomes a drag rather than a click. Small enough to
 *  feel immediate, large enough that a stationary click's few pixels of
 *  incidental hand jitter never accidentally starts a reorder. */
export const DRAG_THRESHOLD_PX = 4;

/** Live state for one in-progress pointer gesture on a tab, from pointerdown
 *  until pointerup/pointercancel. Only one can exist at a time (a second
 *  pointerdown while one is active is ignored — see beginTabDrag). */
interface TabDragState {
  id: number;
  el: HTMLElement;
  /** clientX at pointerdown; every later delta is measured from this. */
  startX: number;
  /** The tab's own horizontal midpoint at pointerdown (viewport space) —
   *  advanced by the same delta as the pointer to get the dragged tab's
   *  *current* center, which is what drop-slot hit-testing compares
   *  against its stationary siblings' centers (see commitReorder). */
  startCenterX: number;
  /** Only the primary button may graduate to a drag (see onTabPointerMove);
   *  a middle/right-click gesture just rides along inert and resolves as
   *  a select on release, same as a below-threshold left-click. */
  primaryButton: boolean;
  /** Flips true once startX has been left behind by DRAG_THRESHOLD_PX.
   *  Gates both the visual feedback and whether release means "select" or
   *  "reorder." */
  dragging: boolean;
}

export class TabStore {
  docs: Doc[] = [];
  activeId: number | null = null;
  /** doc id -> its current tab element, refreshed on every render(). Used
   *  only to measure sibling positions when resolving a drop slot
   *  (commitReorder) — see its own comment for why re-measuring here
   *  beats caching rects at drag-start. */
  private tabElements = new Map<number, HTMLElement>();
  private drag: TabDragState | null = null;

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

  /** Reorder tabs: move the doc at `fromIndex` so it ends up at `toIndex`,
   *  shifting whatever was between the two positions over by one — a plain
   *  array move (splice out, splice back in), not a swap. `toIndex` is
   *  interpreted the same way `Array.prototype.splice`'s insertion index
   *  would be *after* the removal (i.e. against the shortened array), not
   *  against the original — see the pointer-drag caller (commitReorder)
   *  for why that convention is exactly the count of untouched tabs a drop
   *  point has passed.
   *
   *  No-op — `docs` left untouched — when the indices are equal or either
   *  is out of `docs`' current bounds, so a caller resolving a raw pointer
   *  position doesn't need to pre-validate it itself.
   *
   *  `activeId` tracks a doc's *id*, never its array position, so moving
   *  tabs around never needs to touch it: the active tab silently "moves
   *  with" its doc for free, whether or not it's the one being reordered. */
  moveTab(fromIndex: number, toIndex: number): void {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.docs.length ||
      toIndex >= this.docs.length
    ) {
      return;
    }
    const [moved] = this.docs.splice(fromIndex, 1);
    this.docs.splice(toIndex, 0, moved);
  }

  render(): void {
    this.container.replaceChildren();
    this.tabElements.clear();
    for (const doc of this.docs) {
      const tab = document.createElement("div");
      tab.className = doc.id === this.activeId ? "tab active" : "tab";
      // pointerdown (not mousedown/click) doubles as both the click-to-
      // select trigger and the drag-to-reorder start — see beginTabDrag
      // for why selection itself is resolved on release, not here.
      tab.addEventListener("pointerdown", (e) =>
        this.beginTabDrag(e, doc.id, tab),
      );

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = doc.title;
      if (doc.path) tab.title = doc.path;
      tab.appendChild(title);

      const close = document.createElement("button");
      close.className = doc.dirty ? "tab-close dirty" : "tab-close";
      close.textContent = doc.dirty ? "●" : "×";
      close.ariaLabel = t("tabs.closeAria", doc.title);
      // Stops the tab's own pointerdown (drag-arm/select trigger) from
      // ever seeing this gesture, so the close button can never start a
      // drag or flip selection on its way to its own click handler below.
      close.addEventListener("pointerdown", (e) => e.stopPropagation());
      close.addEventListener("click", () => this.events.onClose(doc.id));
      tab.appendChild(close);

      this.container.appendChild(tab);
      this.tabElements.set(doc.id, tab);
    }

    const add = document.createElement("button");
    add.className = "tab-new";
    add.textContent = "+";
    add.ariaLabel = t("tabs.newTabAria");
    add.addEventListener("click", () => this.events.onNew());
    this.container.appendChild(add);
  }

  /** pointerdown on a tab: arms a potential drag, but never itself selects
   *  or reorders — see onTabPointerUp for why both of those are resolved
   *  on release. Deliberately does not gate on button here: middle/right-
   *  click still arm this (so releasing without moving still selects,
   *  matching the pre-drag mousedown behavior for every button), but
   *  `primaryButton` stops onTabPointerMove from ever promoting one of
   *  them to an actual drag — see requirement "中鍵/右鍵不拖".
   *
   *  Not HTML5 drag-and-drop: that API's native drag image/ghost and drop
   *  effect plumbing has long-standing WKWebView/WebView2 inconsistencies.
   *  Pointer events plus manual transform/DOM updates avoid all of that
   *  and are equally mature on both. */
  private beginTabDrag(e: PointerEvent, id: number, tab: HTMLElement): void {
    if (this.drag) return; // one gesture at a time

    const rect = tab.getBoundingClientRect();
    this.drag = {
      id,
      el: tab,
      startX: e.clientX,
      startCenterX: rect.left + rect.width / 2,
      primaryButton: e.button === 0,
      dragging: false,
    };
    // Progressive enhancement: real WKWebView/WebView2 hosts support
    // Pointer Capture, so a fast drag that momentarily leaves the tab's
    // own bounds keeps delivering move/up here instead of to whatever
    // element is now under the cursor. jsdom (unit tests) implements the
    // PointerEvent constructor but not the capture methods at all — the
    // optional call just no-ops there, which is fine: tests dispatch
    // move/up directly at this same element regardless.
    tab.setPointerCapture?.(e.pointerId);
    tab.addEventListener("pointermove", this.onTabPointerMove);
    tab.addEventListener("pointerup", this.onTabPointerUp);
    tab.addEventListener("pointercancel", this.onTabPointerCancel);
  }

  private onTabPointerMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || !drag.primaryButton) return;
    const dx = e.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      // Visual feedback: the dragged tab itself lifts and follows the
      // pointer (translateX below, every move) rather than a separate
      // placeholder element — minimal viable per ROADMAP, reusing
      // styles.css's existing elevation token (see .tab-dragging).
      drag.el.classList.add("tab-dragging");
    }
    drag.el.style.transform = `translateX(${dx}px)`;
  };

  /** Release ends the gesture one of two ways: a plain click (dragging
   *  never crossed the threshold — true for every middle/right-click
   *  gesture, and for a left-click that barely moved) selects, the same
   *  outcome the pre-drag mousedown handler produced, just resolved on
   *  release instead of on press; a real drag instead resolves a drop slot
   *  and commits it. Selecting only here (not also eagerly on pointerdown,
   *  as the old mousedown handler did) sidesteps a real hazard: onSelect
   *  can synchronously cascade into main.ts's
   *  activate() -> showActive() -> this.render(), which replaces every tab
   *  element in the DOM — if that happened while this drag was still
   *  being armed on the *old* element, the gesture would be left operating
   *  on a detached node. Resolving selection only after this gesture's own
   *  teardown below is already done means that cascade, if it happens, no
   *  longer has any in-flight drag state left to invalidate. */
  private onTabPointerUp = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.teardownDrag(drag.el, e.pointerId);
    this.resetDragVisual(drag.el);
    if (drag.dragging) {
      this.commitReorder(drag, e.clientX - drag.startX);
    } else {
      this.events.onSelect(drag.id);
    }
  };

  /** The platform aborted the gesture (e.g. an OS-level gesture interrupt).
   *  Treated as if nothing happened: no select, no reorder — just put the
   *  tab back to normal. */
  private onTabPointerCancel = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.teardownDrag(drag.el, e.pointerId);
    this.resetDragVisual(drag.el);
  };

  private teardownDrag(el: HTMLElement, pointerId: number): void {
    el.removeEventListener("pointermove", this.onTabPointerMove);
    el.removeEventListener("pointerup", this.onTabPointerUp);
    el.removeEventListener("pointercancel", this.onTabPointerCancel);
    el.releasePointerCapture?.(pointerId);
  }

  private resetDragVisual(el: HTMLElement): void {
    el.classList.remove("tab-dragging");
    el.style.transform = "";
  }

  /** Resolve a completed drag to a drop slot and, if it actually changed
   *  anything, commit it. Siblings are measured fresh here rather than
   *  cached at drag-start: none of them move during the drag (only the
   *  dragged tab's own transform changes, which doesn't affect the others'
   *  flex layout), so a fresh read is exactly as valid and avoids keeping
   *  a second rect cache in sync for no benefit.
   *
   *  The drop slot is "how many other tabs' centers the dragged tab's own
   *  current center has passed" — which lines up exactly with moveTab's
   *  post-removal `toIndex` convention (see its doc comment), so the count
   *  below is used as `toIndex` directly with no further translation. */
  private commitReorder(drag: TabDragState, dx: number): void {
    const fromIndex = this.docs.findIndex((d) => d.id === drag.id);
    if (fromIndex === -1) return; // tab closed mid-drag (e.g. a Cmd+W)

    const draggedCenterX = drag.startCenterX + dx;
    let toIndex = 0;
    for (const doc of this.docs) {
      if (doc.id === drag.id) continue;
      const el = this.tabElements.get(doc.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left + rect.width / 2 < draggedCenterX) toIndex++;
    }

    if (toIndex === fromIndex) return; // dropped back where it started
    this.moveTab(fromIndex, toIndex);
    this.render();
    this.events.onReorder();
  }
}
