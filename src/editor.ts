// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import {
  Compartment,
  countColumn,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type RangeSet,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  gutter,
  highlightWhitespace,
} from "@codemirror/view";
import {
  LanguageDescription,
  foldAll as cmFoldAll,
  unfoldAll as cmUnfoldAll,
} from "@codemirror/language";
import {
  copyLineDown as cmCopyLineDown,
  deleteLine as cmDeleteLine,
  moveLineDown as cmMoveLineDown,
  moveLineUp as cmMoveLineUp,
} from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { editorTheme } from "./editor-theme";
import { nearEnd, nearStart } from "./chunkpolicy";
import type { Locale } from "./i18n";
import {
  findHistory,
  pushFindTerm,
  pushReplaceTerm,
  replaceHistory,
} from "./searchhistory";

/**
 * Traditional-Chinese phrases for CM6's own translatable UI strings, keyed
 * by the exact English source phrases CM6 looks up via `EditorState.phrases`
 * (see @codemirror/search's and @codemirror/language's own
 * `phrase(view, "...")` calls) — this is CM6's own built-in translation
 * mechanism, not a new dependency. English needs no entries: it is CM6's
 * built-in default. Covers two surfaces: the @codemirror/search find/replace
 * panel, and the @codemirror/language fold gutter (the marker tooltip, the
 * "…" placeholder's accessible name/tooltip, and the folded/unfolded-range
 * screen-reader announcement) — every key below was confirmed unique to its
 * one call site by grepping every @codemirror package's dist/index.js, so
 * none of these collides with an unrelated phrase() call elsewhere in CM6
 * (checked across @codemirror/commands, /autocomplete, /lint, /search,
 * /state, and /view).
 */
const CM6_PHRASES_ZH_TW: Record<string, string> = {
  Find: "尋找",
  Replace: "取代",
  next: "下一個",
  previous: "上一個",
  all: "全部",
  "match case": "區分大小寫",
  regexp: "正規表示式",
  "by word": "全字符合",
  replace: "取代",
  "replace all": "全部取代",
  close: "關閉",
  "Go to line": "跳至行號",
  go: "前往",
  "replaced match on line $": "已在第 $ 行取代符合項目",
  "replaced $ matches": "已取代 $ 筆符合項目",
  "current match": "目前符合項目",
  "on line": "位於行",
  "Fold line": "摺疊此行",
  "Unfold line": "展開此行",
  "folded code": "已摺疊的程式碼",
  unfold: "展開",
  "Folded lines": "已摺疊行",
  "Unfolded lines": "已展開行",
  to: "至",
};

function cm6Phrases(locale: Locale): Record<string, string> {
  return locale === "zh-TW" ? CM6_PHRASES_ZH_TW : {};
}

export type EditorBuffer = EditorState;

export interface EditorHandle {
  /** Create a detached buffer, e.g. for a newly opened document. */
  newBuffer(content: string, readOnly?: boolean, cursor?: number): EditorBuffer;
  /** Scroll the live buffer's cursor into the center of the view. */
  revealCursor(): void;
  /** Show the given buffer in the editor view. */
  swap(buffer: EditorBuffer): void;
  /** The live buffer currently in the view, including unsaved edits. */
  snapshot(): EditorBuffer;
  /** Append text to the end of the live buffer (continuous reading). */
  appendText(text: string): void;
  /**
   * Insert text at the start of the live buffer, keeping the previously
   * visible content anchored in place (backward continuous reading).
   */
  prependText(text: string): void;
  /** Remove chars from the buffer start, keeping visible content anchored. */
  trimStart(chars: number): void;
  /** Remove chars from the buffer end. */
  trimEnd(chars: number): void;
  /** Text content of the live buffer. */
  content(): string;
  /**
   * Replace the entire live buffer's content in a single transaction (used
   * by the mojibake repair wizard). Unlike `swap(newBuffer(...))`, this
   * dispatches a change on the existing `EditorState` instead of creating a
   * fresh one, so CM6's undo history is preserved and one Undo reverts the
   * whole repair.
   */
  replaceContent(text: string): void;
  focus(): void;
  /** Open the find/replace panel (regex, case and word toggles built in). */
  openSearch(): void;
  /** Move the cursor to a 1-based line and scroll it into view. */
  goToLine(line: number): void;
  /** Replace the set of bookmarked lines shown in the gutter for the live
   *  buffer (buffer-relative, 1-based line numbers — see
   *  src/bookmarks.ts `windowRelativeBookmarks` for how main.ts derives
   *  these for a large-file window, or passes `doc.bookmarks` directly for
   *  a small one). Lines outside the buffer's current range are ignored. */
  setBookmarks(lines: number[]): void;
  /** Toggle soft wrapping of long lines. */
  setLineWrapping(enabled: boolean): void;
  /** Toggle rendering of invisible characters: space dots, tab arrows
   *  (CM6's built-in `highlightWhitespace`), and an EOL mark at the end of
   *  every line that has a trailing newline. Purely visual — never touches
   *  the document, so it is safe to use in large-file/chunked mode. */
  setShowInvisibles(enabled: boolean): void;
  /** Toggle indent-guide vertical lines (one per full tab-stop of leading
   *  whitespace on a line; see `indentGuideLevels` below for the column
   *  math and its blank-line/tab-space design notes). Purely visual, like
   *  `setShowInvisibles` above — never touches the document. */
  setIndentGuides(enabled: boolean): void;
  /** Localize the CM6 find/replace panel's built-in strings (labels,
   *  placeholders, screen-reader announcements) via `EditorState.phrases`.
   *  Purely presentational, like show-invisibles/word-wrap above. */
  setLocale(locale: Locale): void;
  /**
   * Pick a language for the live buffer by filename and load it lazily.
   * `stillWanted` guards against the user switching tabs while the language
   * package chunk is loading.
   */
  setLanguage(filename: string | null, stillWanted: () => boolean): Promise<void>;
  /** Fold every top-level foldable range (CM6's `foldAll` command, also
   *  bound to Mod-Alt-[ by `foldKeymap` — see the View menu's "Fold All").
   *  A safe no-op when the live buffer has no syntax tree to fold from,
   *  e.g. plain text or a truncated large-file buffer (see `setLanguage`
   *  and the `basicSetup` comment above `createEditor`'s `extensions`). */
  foldAll(): void;
  /** Unfold every folded range (CM6's `unfoldAll` command, Mod-Alt-] —
   *  View menu's "Unfold All"). */
  unfoldAll(): void;
  /**
   * Move the current line — or, with a multi-line selection, every
   * selected line as one block — up by one line. Thin wrapper around
   * `@codemirror/commands`'s `moveLineUp`, which is already bound to
   * Alt-ArrowUp (Option-ArrowUp on macOS) by `defaultKeymap` inside
   * `basicSetup`; this exists so the same action is also reachable from
   * the Edit > Line Operations menu (see menu.rs's `move_line_up` — no
   * native accelerator there, same reasoning as `foldAll`/`unfoldAll`
   * above: the key is already owned by CM6 and a duplicate native
   * accelerator would double-fire). A no-op (already the first line, or a
   * read-only buffer — `moveLine` checks `state.readOnly` itself) simply
   * dispatches nothing.
   */
  moveLineUp(): void;
  /** Downward counterpart of `moveLineUp` (CM6's `moveLineDown`,
   *  Alt-ArrowDown / Option-ArrowDown). */
  moveLineDown(): void;
  /**
   * Duplicate the current line — or, with a multi-line selection, every
   * selected line as one block — placing the copy directly below and
   * moving the selection into it. CM6's `copyLineDown` command, already
   * bound to Shift-Alt-ArrowDown (Shift-Option-ArrowDown on macOS); see
   * `moveLineUp`'s doc comment for the no-native-accelerator rationale.
   */
  duplicateLine(): void;
  /** Delete the current line — or, with a multi-line selection, every
   *  selected line as one block. CM6's `deleteLine` command, already bound
   *  to Shift-Mod-k (Shift-Cmd-K on macOS, Shift-Ctrl-K elsewhere); see
   *  `moveLineUp`'s doc comment for the no-native-accelerator rationale. */
  deleteLine(): void;
  /**
   * Apply a pure text transform (see lineops.ts) to a line-bounded region
   * of the live buffer: the current selection expanded to the start of
   * its first line and the end of its last line (the conventional
   * line-command scope), or the whole document when the selection is
   * empty (a plain cursor, no highlighted range). Used by the Edit > Line
   * Operations menu's Sort/Unique/Trim items. Dispatches through
   * `view.dispatch` like every other mutator here, so it goes through
   * CM6's normal undo history. Only the main selection range is
   * considered — multiple cursors are not expanded independently, which
   * keeps the single dispatched change free of the range-overlap
   * failures that expanding several cursors to line boundaries could
   * otherwise hit when two of them land on the same or adjacent lines. A
   * transform that returns its input unchanged dispatches nothing, so a
   * no-op run (e.g. trimming already-clean text) doesn't create a
   * spurious undo step or mark the document dirty.
   */
  transformLines(fn: (text: string) => string): void;
  /**
   * Apply a pure text transform (see lineops.ts) to the current selection
   * verbatim — no line-boundary expansion — or the whole document when
   * the selection is empty. Used by the Line Operations menu's
   * UPPERCASE/lowercase items, which must not swallow a partial-line
   * selection into a full-line one. Same no-op-dispatches-nothing
   * behavior as `transformLines`.
   */
  transformSelection(fn: (text: string) => string): void;
}

export function isEmptyBuffer(buffer: EditorBuffer): boolean {
  return buffer.doc.length === 0;
}

/** Cursor position (character offset) stored in a buffer. */
export function cursorOf(buffer: EditorBuffer): number {
  return buffer.selection.main.head;
}

/** Full text content of a detached buffer. */
export function contentOf(buffer: EditorBuffer): string {
  return buffer.doc.toString();
}

/** Line count of a detached buffer (1-based line numbers go up to this). */
export function lineCountOf(buffer: EditorBuffer): number {
  return buffer.doc.lines;
}

const FIND_DATALIST_ID = "plume-find-history";
const REPLACE_DATALIST_ID = "plume-replace-history";

function populateDatalist(list: HTMLDataListElement, terms: readonly string[]): void {
  list.replaceChildren(
    ...terms.map((term) => {
      const option = document.createElement("option");
      option.value = term;
      return option;
    }),
  );
}

/**
 * Attach a native `<datalist>` MRU dropdown to the CM6 search panel's find
 * and replace fields, and record submitted terms into the history store.
 *
 * This is DOM-layer plumbing, not a fork of CM6 search: it only reads the
 * panel's public, documented class names (`.cm-panel.cm-search`,
 * `.cm-textfield[name=...]`) after CM6 has created the panel, and never
 * touches CM6's own state or event wiring. It runs from the shared
 * `updateListener` below (idempotent via a dataset flag) so it applies no
 * matter which path opened the panel — the app's "find" menu item or CM6's
 * own Mod-f keymap baked into `basicSetup`.
 */
function wireSearchHistory(view: EditorView): void {
  const panel = view.dom.querySelector<HTMLDivElement>(".cm-panel.cm-search");
  if (!panel || panel.dataset.historyWired === "true") return;
  panel.dataset.historyWired = "true";

  const searchField = panel.querySelector<HTMLInputElement>('.cm-textfield[name="search"]');
  const replaceField = panel.querySelector<HTMLInputElement>('.cm-textfield[name="replace"]');

  const searchList = document.createElement("datalist");
  searchList.id = FIND_DATALIST_ID;
  const replaceList = document.createElement("datalist");
  replaceList.id = REPLACE_DATALIST_ID;
  panel.append(searchList, replaceList);
  populateDatalist(searchList, findHistory());
  populateDatalist(replaceList, replaceHistory());

  searchField?.setAttribute("list", FIND_DATALIST_ID);
  replaceField?.setAttribute("list", REPLACE_DATALIST_ID);

  const commitFind = () => {
    if (!searchField) return;
    pushFindTerm(searchField.value);
    populateDatalist(searchList, findHistory());
  };
  const commitReplace = () => {
    if (!replaceField) return;
    pushReplaceTerm(replaceField.value);
    populateDatalist(replaceList, replaceHistory());
  };

  // Enter in the search field runs find-next/previous; Enter in the
  // replace field runs replace-next (which also consumes the find term).
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.target === searchField) {
      commitFind();
    } else if (event.target === replaceField) {
      commitFind();
      commitReplace();
    }
  });
  // The panel's next/prev/select-all buttons act on the find term; replace
  // and replace-all act on both.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const name = target.getAttribute("name");
    if (name === "next" || name === "prev" || name === "select") {
      commitFind();
    } else if (name === "replace" || name === "replaceAll") {
      commitFind();
      commitReplace();
    }
  });
}

/**
 * Character offsets marking the end of every line, within [from, to], that
 * has a trailing newline. The document's last line never has one (that's
 * what makes it the last line) — so a file ending in "\n" correctly marks
 * up to the second-to-last line and leaves the trailing empty line
 * unmarked, and a file with no trailing newline leaves its final line
 * unmarked too. Exported for unit testing; used by `eolDecorations` below,
 * which is the only thing that needs an actual CM6 `EditorView`.
 */
export function eolMarkPositions(doc: Text, from: number, to: number): number[] {
  const positions: number[] = [];
  const lastLine = doc.lines;
  let pos = from;
  while (pos <= to) {
    const line = doc.lineAt(pos);
    if (line.number < lastLine) positions.push(line.to);
    if (line.to >= doc.length) break;
    pos = line.to + 1;
  }
  return positions;
}

/** Renders as `¬` at the end of a line that has a trailing newline. Pure
 *  presentation: CM6 widgets live only in the DOM layer, never in the
 *  document model, so this cannot affect `doc.toString()` (what gets
 *  saved) or large-file chunk offset math (chunkpolicy.ts / chunkwindow.ts
 *  operate on the document model too). */
class EolWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-eol-marker";
    span.textContent = "¬";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const eolMark = Decoration.widget({ widget: new EolWidget(), side: 1 });

/** Only decorates the visible ranges, not the whole document — matters for
 *  large files, where the document can be far bigger than what's on screen. */
function eolDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (const pos of eolMarkPositions(view.state.doc, from, to)) {
      builder.add(pos, pos, eolMark);
    }
  }
  return builder.finish();
}

const eolMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = eolDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = eolDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Show-invisibles extension: CM6's built-in whitespace highlighter (space
 *  dots, tab arrows) plus the custom EOL-mark plugin above (CM6 has no
 *  built-in for end-of-line marks). */
const invisiblesExtension: Extension = [highlightWhitespace(), eolMarks];

// ---- Indent guides (ROADMAP.md Track C / issue #74): vertical lines at
// each full tab-stop of a line's leading whitespace, so deeply nested code
// stays visually readable. No new runtime dependency (the issue explicitly
// flags `@replit/codemirror-indentation-markers` and asks that it be
// evaluated against CLAUDE.md's no-new-dependency constraint first) — this
// is a small hand-rolled ViewPlugin instead, following the exact shape of
// `eolMarks` above: a pure per-line calculation (unit-testable without a
// live EditorView, see editor.test.ts), a `view => DecorationSet` builder
// that only walks `view.visibleRanges`, and a ViewPlugin that recomputes on
// `docChanged`/`viewportChanged`.

/**
 * Number of indent-guide levels to draw for a line: how many full
 * `tabSize`-column-wide runs its leading whitespace spans. E.g. with
 * tabSize 4, 8 leading columns is 2 levels, 5 is only 1 — the remaining
 * single column is not a full level and draws no guide (`Math.floor`).
 * Column width delegates to `@codemirror/state`'s own `countColumn`
 * (rather than a hand-rolled loop) so tab expansion matches exactly how
 * CM6 itself measures tabs: a tab advances to the *next* multiple of
 * tabSize, not a fixed width, so its width depends on the columns already
 * counted before it — e.g. tabSize 4, "   \tx" (3 spaces then a tab) is
 * column 4 (one level), not column 7, because the tab only needed to
 * advance one column to reach the next stop.
 *
 * Design decision (first version, see ROADMAP.md / issue #74): blank
 * lines (empty or all-whitespace) always return 0, never inheriting the
 * indent level of surrounding lines the way some editors extend a guide
 * "through" a blank line in a block. That context-aware extension is left
 * for a future iteration; skipping it keeps this a simple, local,
 * per-line computation with no lookahead/lookbehind across lines, and
 * keeps the ViewPlugin below a pure function of `view.visibleRanges`
 * (large-file windows change which lines are even loaded, so anything
 * that peeked outside the current line would need to special-case
 * truncated buffers too).
 *
 * Exported for unit testing (see editor.test.ts); everything downstream
 * of it needs a real `EditorView` and is exercised manually instead (see
 * that test file's header comment on why — no layout engine in jsdom).
 */
export function indentGuideLevels(lineText: string, tabSize: number): number {
  if (lineText.trim() === "") return 0;
  let end = 0;
  while (end < lineText.length && (lineText[end] === " " || lineText[end] === "\t")) {
    end++;
  }
  return Math.floor(countColumn(lineText, tabSize, end) / tabSize);
}

/** Only decorates the visible ranges, not the whole document — same
 *  large-file rationale as `eolDecorations` above. Large-file (truncated)
 *  buffers get no language loaded but are plain text, so indent guides
 *  work on them same as anywhere else: the calculation is purely textual,
 *  never touches the syntax tree. */
function indentGuideDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, tabSize } = view.state;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const levels = indentGuideLevels(line.text, tabSize);
      if (levels > 0) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              class: "cm-indent-guide",
              style: `--indent-guide-levels:${levels}`,
            },
          }),
        );
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const indentGuidePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      // Tab size is document-wide, not per-line, so it's set once on the
      // editor root here rather than repeated in every line's inline
      // style — editor-theme.ts's `.cm-indent-guide` rule reads it back
      // via `var(--indent-guide-tabsize, 4)`.
      view.dom.style.setProperty("--indent-guide-tabsize", String(view.state.tabSize));
      this.decorations = indentGuideDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        update.view.dom.style.setProperty(
          "--indent-guide-tabsize",
          String(update.view.state.tabSize),
        );
        this.decorations = indentGuideDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Indent-guides extension, gated behind the `indentGuides` compartment in
 *  `createEditor` below (View menu toggle, default on — see
 *  `preferences.ts`). */
const indentGuidesExtension: Extension = indentGuidePlugin;

// ---- Bookmark gutter (ROADMAP.md Track B). Bookmarks are tracked as plain
// buffer-relative line numbers (see `EditorHandle.setBookmarks` and
// src/bookmarks.ts), not CM6 positions: the marker set is replaced wholesale
// by `setBookmarkLines` (tab switches, goto jumps, toggling) rather than
// mapped through document changes, so it deliberately does *not* "stick" to
// content the way a tracked RangeSet would — editing lines above a bookmark
// leaves it pointing at the same line number, not the same text. Each
// gutter recompute re-resolves line numbers to fresh positions via
// `state.doc.line(n)`, which is exactly this "line numbers, not positions"
// semantics for free.
class BookmarkMarker extends GutterMarker {
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = "cm-bookmark-marker";
    span.textContent = "●";
    return span;
  }
}
const bookmarkMarker = new BookmarkMarker();

const setBookmarkLines = StateEffect.define<number[]>();

/** Buffer-relative (1-based) bookmarked line numbers for the live buffer. */
const bookmarkLinesField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBookmarkLines)) return effect.value;
    }
    return value;
  },
});

function bookmarkMarkers(state: EditorState, lines: readonly number[]): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  // GutterMarker ranges must be added in ascending position order.
  for (const line of [...lines].sort((a, b) => a - b)) {
    if (line < 1 || line > state.doc.lines) continue; // stale/out-of-range
    const pos = state.doc.line(line).from;
    builder.add(pos, pos, bookmarkMarker);
  }
  return builder.finish();
}

/** A slim always-present gutter, forced leftmost (of the line-number
 *  gutter) for the conventional bookmark/breakpoint-margin position; empty
 *  (no markers) is the common case. */
const bookmarkGutter = Prec.highest(
  gutter({
    class: "cm-bookmark-gutter",
    markers: (view) => bookmarkMarkers(view.state, view.state.field(bookmarkLinesField)),
  }),
);

// ---- Line-operations selection expansion (Edit > Line Operations menu;
// see lineops.ts for the actual sort/unique/trim/case transforms).
// `transformLines` below needs the [from, to) span a non-empty selection
// expands to once its first and last lines are included in full. lineops.ts
// has a pure-string version of this same computation, `lineSpanForSelection`
// — unit-testable without a live view, same reason `eolMarkPositions` and
// `indentGuideLevels` above are pure functions here instead of living
// inline in a ViewPlugin. But answering it from a plain string means
// materializing the whole document with `doc.toString()` first, which
// `transformLines` used to do on every line-operation dispatch just to
// compute two offsets — wasteful for a large document (issue #107).
// `Text.lineAt` answers the identical question directly against the CM6
// rope, with no materialization, so `transformLines` uses that instead.
// `lineSpanForSelection` is kept (not deleted) as a pure-string reference
// implementation; editor.test.ts checks the two agree on every boundary
// case lineops.test.ts already exercises against the string version, so
// this can't silently drift from that one's issue #99/PR #106 to-1
// semantics.

/**
 * Character offsets marking the `[from, to)` span, expanded to whole
 * lines, that `transformLines` should act on for a given non-empty
 * selection — the `Text.lineAt`-based counterpart of lineops.ts's
 * `lineSpanForSelection`, operating on a live CM6 document (`Text`)
 * instead of a materialized string.
 *
 * Same to-1 semantics as `lineSpanForSelection` (issue #99 / PR #106): the
 * end line is resolved from `to - 1`, the offset of the last character
 * actually inside the selection, never from `to` itself — otherwise a
 * selection whose exclusive end lands exactly at column 1 of the next line
 * (right after some line's newline) would pull that whole next line into
 * the span even though the user never selected any of it.
 *
 * Not defined for an empty selection (`from === to`, a cursor): callers
 * give a cursor its own whole-document meaning instead of a line span (see
 * `transformLines` below), so this throws rather than silently returning a
 * nonsensical (possibly inverted) range — same contract as
 * `lineSpanForSelection`.
 */
export function lineSpanForSelectionInDoc(
  doc: Text,
  from: number,
  to: number,
): { from: number; to: number } {
  if (from === to) {
    throw new RangeError("lineSpanForSelectionInDoc requires a non-empty selection (from !== to)");
  }
  return { from: doc.lineAt(from).from, to: doc.lineAt(to - 1).to };
}

export function createEditor(
  parent: Element,
  onDocChanged: () => void,
  onCursorMoved: (line: number, column: number) => void,
  onViewportNearEnd: () => void,
  onViewportNearStart: () => void,
): EditorHandle {
  const language = new Compartment();
  const wrapping = new Compartment();
  const invisibles = new Compartment();
  const indentGuides = new Compartment();
  const phrases = new Compartment();
  // Wrapping, show-invisibles, indent-guides, and the search-panel locale
  // are global but each tab's EditorState carries its own compartment
  // value, so they're re-applied on every swap. The color theme is fully
  // token-driven (CSS variables), so it needs no compartment or per-swap
  // reconfiguration — see editor-theme.ts.
  let currentWrapping: Extension = [];
  let currentInvisibles: Extension = [];
  let currentIndentGuides: Extension = [];
  let currentPhrases: Extension = [];
  const extensions = [
    // `basicSetup` bundles CM6's fold gutter and fold keymap out of the box
    // (see node_modules/codemirror/dist/index.js: `foldGutter()` and
    // `...foldKeymap` are already in its array) — ROADMAP.md's "code
    // folding" item is therefore mostly free, and this file must NOT call
    // `foldGutter()` or add `foldKeymap` again anywhere else: `gutter()`
    // extensions aren't deduplicated by class name, so a second
    // `foldGutter()` call would render a second, empty fold-gutter column
    // beside this one. Folding depends on the syntax tree, exactly like the
    // syntax-highlighting `language` compartment below, so it needs no
    // compartment of its own: truncated (large-file) buffers never get a
    // language loaded (`doc.truncated ? null : doc.title` in main.ts's
    // `showActive`), so their fold gutter shows no arrows and
    // `foldAll`/`unfoldAll` are no-ops — the same "no foldable ranges, no
    // arrows" behavior a small plain-text file with no recognized language
    // already gets for free.
    basicSetup,
    editorTheme,
    bookmarkLinesField,
    bookmarkGutter,
    language.of([]),
    wrapping.of([]),
    invisibles.of([]),
    indentGuides.of([]),
    phrases.of([]),
    EditorView.updateListener.of((update) => {
      wireSearchHistory(update.view);
      if (update.docChanged) onDocChanged();
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorMoved(line.number, head - line.from + 1);
      }
      if (update.viewportChanged || update.docChanged) {
        if (nearEnd(update.view.viewport.to, update.state.doc.length)) {
          onViewportNearEnd();
        }
        if (nearStart(update.view.viewport.from)) {
          onViewportNearStart();
        }
      }
    }),
  ];
  const newBuffer = (
    content: string,
    readOnly = false,
    cursor = 0,
  ): EditorBuffer =>
    EditorState.create({
      doc: content,
      selection: { anchor: Math.min(Math.max(cursor, 0), content.length) },
      extensions: readOnly
        ? [extensions, EditorState.readOnly.of(true), EditorView.editable.of(false)]
        : extensions,
    });

  const view = new EditorView({ state: newBuffer(""), parent });

  return {
    newBuffer,
    swap: (buffer) => {
      view.setState(buffer);
      view.dispatch({
        effects: [
          wrapping.reconfigure(currentWrapping),
          invisibles.reconfigure(currentInvisibles),
          indentGuides.reconfigure(currentIndentGuides),
          phrases.reconfigure(currentPhrases),
        ],
      });
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      onCursorMoved(line.number, head - line.from + 1);
    },
    snapshot: () => view.state,
    content: () => view.state.doc.toString(),
    replaceContent: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    focus: () => view.focus(),
    appendText: (text) => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
      });
    },
    prependText: (text) => {
      const anchor = view.viewport.from;
      view.dispatch({ changes: { from: 0, to: 0, insert: text } });
      view.dispatch({
        effects: EditorView.scrollIntoView(anchor + text.length, {
          y: "start",
        }),
      });
    },
    trimStart: (chars) => {
      const anchor = view.viewport.from;
      view.dispatch({ changes: { from: 0, to: chars } });
      view.dispatch({
        effects: EditorView.scrollIntoView(Math.max(anchor - chars, 0), {
          y: "start",
        }),
      });
    },
    trimEnd: (chars) => {
      const length = view.state.doc.length;
      view.dispatch({ changes: { from: length - chars, to: length } });
    },
    openSearch: () => {
      openSearchPanel(view);
    },
    revealCursor: () => {
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: "center",
        }),
      });
    },
    goToLine: (line) => {
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const info = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: info.from },
        effects: EditorView.scrollIntoView(info.from, { y: "center" }),
      });
      view.focus();
    },
    setBookmarks: (lines) => {
      view.dispatch({ effects: setBookmarkLines.of(lines) });
    },
    setLineWrapping: (enabled) => {
      currentWrapping = enabled ? EditorView.lineWrapping : [];
      view.dispatch({ effects: wrapping.reconfigure(currentWrapping) });
    },
    setShowInvisibles: (enabled) => {
      currentInvisibles = enabled ? invisiblesExtension : [];
      view.dispatch({ effects: invisibles.reconfigure(currentInvisibles) });
    },
    setIndentGuides: (enabled) => {
      currentIndentGuides = enabled ? indentGuidesExtension : [];
      view.dispatch({ effects: indentGuides.reconfigure(currentIndentGuides) });
    },
    setLocale: (locale) => {
      currentPhrases = EditorState.phrases.of(cm6Phrases(locale));
      view.dispatch({ effects: phrases.reconfigure(currentPhrases) });
    },
    async setLanguage(filename, stillWanted) {
      const description = filename
        ? LanguageDescription.matchFilename(languages, filename)
        : null;
      const support = description ? await description.load() : [];
      if (!stillWanted()) return;
      view.dispatch({ effects: language.reconfigure(support) });
    },
    foldAll: () => {
      cmFoldAll(view);
    },
    unfoldAll: () => {
      cmUnfoldAll(view);
    },
    moveLineUp: () => {
      cmMoveLineUp(view);
    },
    moveLineDown: () => {
      cmMoveLineDown(view);
    },
    duplicateLine: () => {
      cmCopyLineDown(view);
    },
    deleteLine: () => {
      cmDeleteLine(view);
    },
    transformLines: (fn) => {
      const { state } = view;
      const range = state.selection.main;
      // range.to is exclusive; the line-span expansion (issue #99) must
      // resolve the end line from range.to - 1, not range.to itself — see
      // lineSpanForSelectionInDoc's doc comment above.
      const { from, to } = range.empty
        ? { from: 0, to: state.doc.length }
        : lineSpanForSelectionInDoc(state.doc, range.from, range.to);
      const original = state.sliceDoc(from, to);
      const insert = fn(original);
      if (insert === original) return;
      view.dispatch({ changes: { from, to, insert } });
    },
    transformSelection: (fn) => {
      const { state } = view;
      const range = state.selection.main;
      const from = range.empty ? 0 : range.from;
      const to = range.empty ? state.doc.length : range.to;
      const original = state.sliceDoc(from, to);
      const insert = fn(original);
      if (insert === original) return;
      view.dispatch({ changes: { from, to, insert } });
    },
  };
}
