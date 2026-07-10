// Preferences state, application, and the in-window settings dialog.
import type { EditorHandle } from "./editor";
import { ENCODINGS, REOPEN_ENCODINGS } from "./encodings";
import { normalizeTable } from "./extensionEncodings";
import {
  loadPreferences,
  savePreferences,
  syncThemeMenu,
  type Preferences,
} from "./ipc";

const FALLBACK_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Built-in theme choices: "system" plus two token sets each for a light
 *  and a dark base (see styles.css `html[data-theme]` blocks). Shared by
 *  the Preferences dialog select and the View > Theme menu (menu.rs uses
 *  the same ids prefixed with "theme_"). */
export const THEMES: { value: string; label: string }[] = [
  { value: "system", label: "Follow system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "paper", label: "Paper" },
  { value: "dusk", label: "Dusk" },
];

let current: Preferences = {
  fontFamily: "",
  fontSize: 13,
  theme: "system",
  defaultEncoding: "UTF-8",
  defaultBom: false,
  wordWrap: true,
  showInvisibles: false,
  extensionEncodings: [],
};

let editorRef: EditorHandle | null = null;
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export function preferences(): Preferences {
  return current;
}

function applyFont(): void {
  const root = document.documentElement;
  root.style.setProperty(
    "--editor-font-family",
    current.fontFamily.trim() === "" ? FALLBACK_FONT : current.fontFamily,
  );
  root.style.setProperty("--editor-font-size", `${current.fontSize}px`);
}

function applyTheme(): void {
  const root = document.documentElement;
  // Colors are CSS-variable driven (see styles.css), so there is nothing to
  // push into the editor here — the token cascade handles both the OS
  // media query and this explicit override automatically.
  if (current.theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = current.theme;
  }
}

function applyAll(): void {
  applyFont();
  applyTheme();
  editorRef?.setLineWrapping(current.wordWrap);
  editorRef?.setShowInvisibles(current.showInvisibles);
}

const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_DEFAULT = 13;

/** Adjust the editor font size by delta (0 resets) and persist. */
export function adjustFontSize(delta: number): void {
  current.fontSize =
    delta === 0
      ? FONT_SIZE_DEFAULT
      : Math.min(Math.max(current.fontSize + delta, FONT_SIZE_MIN), FONT_SIZE_MAX);
  applyFont();
  void savePreferences(current).catch(() => {
    // Best-effort persistence; the in-memory setting still applies.
  });
}

/** Toggle word wrap (driven by the View menu check item) and persist. */
export function toggleWordWrap(): void {
  current.wordWrap = !current.wordWrap;
  editorRef?.setLineWrapping(current.wordWrap);
  void savePreferences(current).catch(() => {
    // Best-effort persistence; the in-memory setting still applies.
  });
}

/** Toggle showing invisible characters (driven by the View menu check
 *  item) and persist. */
export function toggleShowInvisibles(): void {
  current.showInvisibles = !current.showInvisibles;
  editorRef?.setShowInvisibles(current.showInvisibles);
  void savePreferences(current).catch(() => {
    // Best-effort persistence; the in-memory setting still applies.
  });
}

/** Set the theme (driven by the View > Theme menu radio group or the
 *  Preferences dialog), apply it, persist it, and sync the native menu's
 *  checkmarks so the two entry points never disagree. */
export function setTheme(theme: string): void {
  current.theme = theme;
  applyTheme();
  void savePreferences(current).catch(() => {
    // Best-effort persistence; the in-memory setting still applies.
  });
  void syncThemeMenu(theme).catch(() => {
    // Best-effort menu sync; the applied theme is still correct.
  });
}

export async function initPreferences(editor: EditorHandle): Promise<void> {
  editorRef = editor;
  try {
    current = await loadPreferences();
  } catch {
    // Fall back to defaults; preferences must never block startup.
  }
  applyAll();
  systemDark.addEventListener("change", () => {
    if (current.theme === "system") applyTheme();
  });
}

function row(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "prefs-row";
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.appendChild(text);
  wrapper.appendChild(control);
  return wrapper;
}

function select(options: { label: string; value: string }[]): HTMLSelectElement {
  const el = document.createElement("select");
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    el.appendChild(opt);
  }
  return el;
}

/** Build the "Per-extension encodings" editor: a small table of
 *  extension + encoding rows with remove buttons and an Add button.
 *  `read()` returns the rows as currently edited (normalization and
 *  dedupe happen on save, in extensionEncodings.ts `normalizeTable`). */
function extensionTable(initial: [string, string][]): {
  element: HTMLElement;
  read: () => { extension: string; encoding: string }[];
} {
  const section = document.createElement("div");
  section.className = "prefs-ext-section";

  const heading = document.createElement("div");
  heading.className = "prefs-ext-heading";
  heading.textContent = "Per-extension encodings";
  section.appendChild(heading);

  const hint = document.createElement("div");
  hint.className = "prefs-ext-hint";
  hint.textContent =
    "Files with these extensions open with the given encoding when it " +
    "decodes cleanly; a BOM or a clear mismatch still wins.";
  section.appendChild(hint);

  const rows = document.createElement("div");
  rows.className = "prefs-ext-rows";
  section.appendChild(rows);

  const addRow = (extension: string, encoding: string): void => {
    const row = document.createElement("div");
    row.className = "prefs-ext-row";

    const ext = document.createElement("input");
    ext.type = "text";
    ext.className = "prefs-ext-name";
    ext.placeholder = "txt";
    ext.value = extension;

    const enc = select(
      REOPEN_ENCODINGS.map((e) => ({ label: e.label, value: e.value })),
    );
    enc.className = "prefs-ext-encoding";
    enc.value = encoding;
    if (enc.selectedIndex < 0) enc.selectedIndex = 0;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "prefs-ext-remove";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => row.remove());

    row.appendChild(ext);
    row.appendChild(enc);
    row.appendChild(remove);
    rows.appendChild(row);
  };

  for (const [extension, encoding] of initial) addRow(extension, encoding);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "prefs-ext-add";
  add.textContent = "Add";
  add.addEventListener("click", () => {
    addRow("", "UTF-8");
    const inputs = rows.querySelectorAll<HTMLInputElement>(".prefs-ext-name");
    inputs[inputs.length - 1]?.focus();
  });
  section.appendChild(add);

  return {
    element: section,
    read: () =>
      [...rows.querySelectorAll<HTMLElement>(".prefs-ext-row")].map((row) => ({
        extension:
          row.querySelector<HTMLInputElement>(".prefs-ext-name")?.value ?? "",
        encoding:
          row.querySelector<HTMLSelectElement>(".prefs-ext-encoding")?.value ??
          "",
      })),
  };
}

export function showPreferencesDialog(): void {
  if (document.querySelector(".prefs-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "prefs-overlay";
  const dialog = document.createElement("div");
  dialog.className = "prefs-dialog";

  const title = document.createElement("h2");
  title.textContent = "Preferences";
  dialog.appendChild(title);

  const fontFamily = document.createElement("input");
  fontFamily.type = "text";
  fontFamily.placeholder = "System default";
  fontFamily.value = current.fontFamily;
  dialog.appendChild(row("Editor font", fontFamily));

  const fontSize = document.createElement("input");
  fontSize.type = "number";
  fontSize.min = "9";
  fontSize.max = "32";
  fontSize.value = String(current.fontSize);
  dialog.appendChild(row("Font size", fontSize));

  const theme = select(THEMES.map((t) => ({ label: t.label, value: t.value })));
  theme.value = current.theme;
  dialog.appendChild(row("Theme", theme));

  const encoding = select(
    ENCODINGS.map((e) => ({
      label: e.label,
      value: `${e.value} ${e.withBom}`,
    })),
  );
  encoding.value = `${current.defaultEncoding} ${current.defaultBom}`;
  if (encoding.selectedIndex < 0) encoding.selectedIndex = 0;
  dialog.appendChild(row("Encoding for new files", encoding));

  const extensions = extensionTable(current.extensionEncodings);
  dialog.appendChild(extensions.element);

  const buttons = document.createElement("div");
  buttons.className = "prefs-buttons";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.textContent = "Save";
  save.className = "prefs-save";
  buttons.appendChild(cancel);
  buttons.appendChild(save);
  dialog.appendChild(buttons);

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  cancel.addEventListener("click", close);
  save.addEventListener("click", () => {
    const [encValue, encBom] = encoding.value.split(" ");
    const size = Number.parseInt(fontSize.value, 10);
    current = {
      fontFamily: fontFamily.value,
      fontSize: Number.isFinite(size) ? Math.min(Math.max(size, 9), 32) : 13,
      theme: theme.value,
      defaultEncoding: encValue,
      defaultBom: encBom === "true",
      wordWrap: current.wordWrap,
      showInvisibles: current.showInvisibles,
      extensionEncodings: normalizeTable(extensions.read()),
    };
    applyAll();
    void savePreferences(current).catch(() => {
      // Best-effort persistence; the in-memory settings still apply.
    });
    void syncThemeMenu(current.theme).catch(() => {
      // Best-effort menu sync; the applied theme is still correct.
    });
    close();
  });
  document.addEventListener("keydown", onKey);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  fontFamily.focus();
}
