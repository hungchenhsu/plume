import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as confirmDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { createEditor, isEmptyBuffer } from "./editor";
import { openDocument, saveDocument } from "./ipc";
import { updateStatusBar } from "./statusbar";
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

const editor = createEditor(document.querySelector("#editor")!, () => {
  const doc = tabs.active;
  if (doc && !doc.dirty) {
    doc.dirty = true;
    tabs.render();
  }
});

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function makeUntitled(): Doc {
  untitledCounter += 1;
  return {
    id: nextId++,
    path: null,
    title: untitledCounter === 1 ? "Untitled" : `Untitled-${untitledCounter}`,
    encoding: "UTF-8",
    withBom: false,
    lineEnding: defaultLineEnding,
    malformed: false,
    dirty: false,
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
  editor.focus();
}

function activate(id: number): void {
  if (id === tabs.activeId) return;
  const current = tabs.active;
  if (current) current.buffer = editor.snapshot();
  tabs.setActive(id);
  showActive();
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

async function openFileFlow(): Promise<void> {
  const path = await openDialog({ multiple: false, directory: false });
  if (path === null) return;
  const existing = tabs.findByPath(path);
  if (existing) {
    activate(existing.id);
    return;
  }
  try {
    const opened = await openDocument(path);
    const previous = tabs.active;
    if (previous) previous.buffer = editor.snapshot();
    tabs.add({
      id: nextId++,
      path: opened.path,
      title: basename(opened.path),
      encoding: opened.encoding,
      withBom: opened.hadBom,
      lineEnding: opened.lineEnding,
      malformed: opened.malformed,
      dirty: false,
      buffer: editor.newBuffer(opened.content),
    });
    if (previous && isPristineUntitled(previous)) tabs.close(previous.id);
    showActive();
  } catch (error) {
    await messageDialog(String(error), { title: "Open failed", kind: "error" });
  }
}

async function saveFlow(saveAs: boolean): Promise<void> {
  const doc = tabs.active;
  if (!doc) return;
  let path = doc.path;
  if (saveAs || path === null) {
    path = await saveDialog({ defaultPath: path ?? doc.title });
    if (path === null) return;
  }
  try {
    const result = await saveDocument({
      path,
      content: editor.content(),
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
    });
    doc.path = path;
    doc.title = basename(path);
    doc.dirty = false;
    // Mixed line endings are written out as LF by the core.
    if (doc.lineEnding === "Mixed") doc.lineEnding = "LF";
    tabs.render();
    updateStatusBar(doc);
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

async function closeTab(id: number): Promise<void> {
  const doc = tabs.get(id);
  if (!doc) return;
  if (doc.dirty) {
    const discard = await confirmDialog(
      `"${doc.title}" has unsaved changes. Discard them?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Discard" },
    );
    if (!discard) return;
  }
  const wasActive = id === tabs.activeId;
  tabs.close(id);
  if (tabs.docs.length === 0) tabs.add(makeUntitled());
  if (wasActive) showActive();
  else tabs.render();
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
  }
});

void getCurrentWindow().onCloseRequested(async (event) => {
  const dirtyCount = tabs.docs.filter((d) => d.dirty).length;
  if (dirtyCount === 0) return;
  const discard = await confirmDialog(
    dirtyCount === 1
      ? "1 file has unsaved changes. Discard and quit?"
      : `${dirtyCount} files have unsaved changes. Discard and quit?`,
    { title: "Unsaved changes", kind: "warning", okLabel: "Discard" },
  );
  if (!discard) event.preventDefault();
});

tabs.add(makeUntitled());
showActive();
