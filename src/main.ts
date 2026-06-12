import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
  message as messageDialog,
} from "@tauri-apps/plugin-dialog";

interface OpenedDocument {
  path: string;
  content: string;
  encoding: string;
  hadBom: boolean;
  malformed: boolean;
  lineEnding: string;
}

interface SaveResult {
  unmappable: boolean;
}

interface DocumentState {
  path: string | null;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
}

const doc: DocumentState = {
  path: null,
  encoding: "UTF-8",
  withBom: false,
  lineEnding: "LF",
};

const statusPath = document.querySelector<HTMLElement>("#status-path")!;
const statusEncoding = document.querySelector<HTMLElement>("#status-encoding")!;
const statusLineEnding = document.querySelector<HTMLElement>(
  "#status-line-ending",
)!;
const statusWarning = document.querySelector<HTMLElement>("#status-warning")!;

function updateStatusBar(malformed = false): void {
  statusPath.textContent = doc.path ?? "No file";
  statusEncoding.textContent = doc.withBom
    ? `${doc.encoding} BOM`
    : doc.encoding;
  statusLineEnding.textContent = doc.lineEnding;
  statusWarning.hidden = !malformed;
}

function setDocument(opened: OpenedDocument): void {
  doc.path = opened.path;
  doc.encoding = opened.encoding;
  doc.withBom = opened.hadBom;
  doc.lineEnding = opened.lineEnding;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: opened.content },
  });
  updateStatusBar(opened.malformed);
}

async function openFile(): Promise<void> {
  const path = await openDialog({ multiple: false, directory: false });
  if (path === null) return;
  try {
    const opened = await invoke<OpenedDocument>("open_document", { path });
    setDocument(opened);
  } catch (error) {
    await messageDialog(String(error), { title: "Open failed", kind: "error" });
  }
}

async function saveFile(saveAs: boolean): Promise<void> {
  let path = doc.path;
  if (saveAs || path === null) {
    path = await saveDialog({ defaultPath: path ?? undefined });
    if (path === null) return;
  }
  try {
    const result = await invoke<SaveResult>("save_document", {
      path,
      content: view.state.doc.toString(),
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
    });
    doc.path = path;
    updateStatusBar();
    if (result.unmappable) {
      await messageDialog(
        `Some characters could not be represented in ${doc.encoding} and were replaced.`,
        { title: "Encoding warning", kind: "warning" },
      );
    }
  } catch (error) {
    await messageDialog(String(error), { title: "Save failed", kind: "error" });
  }
}

const fileKeymap = keymap.of([
  {
    key: "Mod-o",
    run: () => {
      void openFile();
      return true;
    },
  },
  {
    key: "Mod-s",
    run: () => {
      void saveFile(false);
      return true;
    },
  },
  {
    key: "Mod-Shift-s",
    run: () => {
      void saveFile(true);
      return true;
    },
  },
]);

const view = new EditorView({
  doc: "",
  extensions: [fileKeymap, basicSetup],
  parent: document.querySelector("#editor")!,
});

view.focus();
updateStatusBar();
