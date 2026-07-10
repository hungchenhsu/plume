// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { editorTheme } from "./editor-theme";
import { nearEnd, nearStart } from "./chunkpolicy";
import {
  findHistory,
  pushFindTerm,
  pushReplaceTerm,
  replaceHistory,
} from "./searchhistory";

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
  focus(): void;
  /** Open the find/replace panel (regex, case and word toggles built in). */
  openSearch(): void;
  /** Move the cursor to a 1-based line and scroll it into view. */
  goToLine(line: number): void;
  /** Toggle soft wrapping of long lines. */
  setLineWrapping(enabled: boolean): void;
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

export function createEditor(
  parent: Element,
  onDocChanged: () => void,
  onCursorMoved: (line: number, column: number) => void,
  onViewportNearEnd: () => void,
  onViewportNearStart: () => void,
): EditorHandle {
  const language = new Compartment();
  const wrapping = new Compartment();
  // Wrapping is global but each tab's EditorState carries its own
  // compartment value, so it's re-applied on every swap. The color theme is
  // fully token-driven (CSS variables), so it needs no compartment or
  // per-swap reconfiguration — see editor-theme.ts.
  let currentWrapping: Extension = [];
  const extensions = [
    basicSetup,
    editorTheme,
    language.of([]),
    wrapping.of([]),
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
        effects: wrapping.reconfigure(currentWrapping),
      });
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      onCursorMoved(line.number, head - line.from + 1);
    },
    snapshot: () => view.state,
    content: () => view.state.doc.toString(),
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
