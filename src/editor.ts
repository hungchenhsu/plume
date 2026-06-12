// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

export type EditorBuffer = EditorState;

export interface EditorHandle {
  /** Create a detached buffer, e.g. for a newly opened document. */
  newBuffer(content: string): EditorBuffer;
  /** Show the given buffer in the editor view. */
  swap(buffer: EditorBuffer): void;
  /** The live buffer currently in the view, including unsaved edits. */
  snapshot(): EditorBuffer;
  /** Text content of the live buffer. */
  content(): string;
  focus(): void;
  /** Open the find/replace panel (regex, case and word toggles built in). */
  openSearch(): void;
  /** Move the cursor to a 1-based line and scroll it into view. */
  goToLine(line: number): void;
  /** Switch the editor between the light and dark color theme. */
  setDarkTheme(dark: boolean): void;
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

export function createEditor(
  parent: Element,
  onDocChanged: () => void,
): EditorHandle {
  const language = new Compartment();
  const theme = new Compartment();
  // The theme is global but each tab's EditorState carries its own
  // compartment value, so the current theme is re-applied on every swap.
  let currentTheme: Extension = [];
  const extensions = [
    basicSetup,
    language.of([]),
    theme.of([]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChanged();
    }),
  ];
  const newBuffer = (content: string): EditorBuffer =>
    EditorState.create({ doc: content, extensions });

  const view = new EditorView({ state: newBuffer(""), parent });

  return {
    newBuffer,
    swap: (buffer) => {
      view.setState(buffer);
      view.dispatch({ effects: theme.reconfigure(currentTheme) });
    },
    snapshot: () => view.state,
    content: () => view.state.doc.toString(),
    focus: () => view.focus(),
    openSearch: () => {
      openSearchPanel(view);
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
