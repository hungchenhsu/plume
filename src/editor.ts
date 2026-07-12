// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  highlightWhitespace,
} from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
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
 * Traditional-Chinese phrases for the @codemirror/search find/replace
 * panel, keyed by the exact English source phrases CM6 looks up via
 * `EditorState.phrases` (see @codemirror/search's `phrase(view, "...")`
 * calls) — this is CM6's own built-in translation mechanism, not a new
 * dependency. English needs no entries: it is CM6's built-in default.
 */
const SEARCH_PANEL_PHRASES_ZH_TW: Record<string, string> = {
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
};

function searchPanelPhrases(locale: Locale): Record<string, string> {
  return locale === "zh-TW" ? SEARCH_PANEL_PHRASES_ZH_TW : {};
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
  /** Toggle soft wrapping of long lines. */
  setLineWrapping(enabled: boolean): void;
  /** Toggle rendering of invisible characters: space dots, tab arrows
   *  (CM6's built-in `highlightWhitespace`), and an EOL mark at the end of
   *  every line that has a trailing newline. Purely visual — never touches
   *  the document, so it is safe to use in large-file/chunked mode. */
  setShowInvisibles(enabled: boolean): void;
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
  const phrases = new Compartment();
  // Wrapping, show-invisibles, and the search-panel locale are global but
  // each tab's EditorState carries its own compartment value, so they're
  // re-applied on every swap. The color theme is fully token-driven (CSS
  // variables), so it needs no compartment or per-swap reconfiguration —
  // see editor-theme.ts.
  let currentWrapping: Extension = [];
  let currentInvisibles: Extension = [];
  let currentPhrases: Extension = [];
  const extensions = [
    basicSetup,
    editorTheme,
    language.of([]),
    wrapping.of([]),
    invisibles.of([]),
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
    setLineWrapping: (enabled) => {
      currentWrapping = enabled ? EditorView.lineWrapping : [];
      view.dispatch({ effects: wrapping.reconfigure(currentWrapping) });
    },
    setShowInvisibles: (enabled) => {
      currentInvisibles = enabled ? invisiblesExtension : [];
      view.dispatch({ effects: invisibles.reconfigure(currentInvisibles) });
    },
    setLocale: (locale) => {
      currentPhrases = EditorState.phrases.of(searchPanelPhrases(locale));
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
  };
}
