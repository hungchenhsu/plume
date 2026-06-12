// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { nearEnd, nearStart } from "./chunkpolicy";

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
  /** Switch the editor between the light and dark color theme. */
  setDarkTheme(dark: boolean): void;
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

export function createEditor(
  parent: Element,
  onDocChanged: () => void,
  onCursorMoved: (line: number, column: number) => void,
  onViewportNearEnd: () => void,
  onViewportNearStart: () => void,
): EditorHandle {
  const language = new Compartment();
  const theme = new Compartment();
  const wrapping = new Compartment();
  // Theme and wrapping are global but each tab's EditorState carries its
  // own compartment values, so both are re-applied on every swap.
  let currentTheme: Extension = [];
  let currentWrapping: Extension = [];
  const extensions = [
    basicSetup,
    language.of([]),
    theme.of([]),
    wrapping.of([]),
    EditorView.updateListener.of((update) => {
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
          theme.reconfigure(currentTheme),
          wrapping.reconfigure(currentWrapping),
        ],
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
    setDarkTheme: (dark) => {
      currentTheme = dark ? oneDark : [];
      view.dispatch({ effects: theme.reconfigure(currentTheme) });
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
