// The only module allowed to import CodeMirror. Everything else sees the
// editor through this interface and the opaque EditorBuffer type, so the
// editor surface stays swappable (see ARCHITECTURE.md).
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

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
  const extensions = [
    basicSetup,
    language.of([]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChanged();
    }),
  ];
  const newBuffer = (content: string): EditorBuffer =>
    EditorState.create({ doc: content, extensions });

  const view = new EditorView({ state: newBuffer(""), parent });

  return {
    newBuffer,
    swap: (buffer) => view.setState(buffer),
    snapshot: () => view.state,
    content: () => view.state.doc.toString(),
    focus: () => view.focus(),
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
