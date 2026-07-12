// Preferences state, application, and the in-window settings dialog.
import type { EditorHandle } from "./editor";
import { encodingChoices, reopenEncodingChoices } from "./encodings";
import { normalizeTable } from "./extensionEncodings";
import { effectiveLocale, setLocale, t, type Locale } from "./i18n";
import {
  loadPreferences,
  retitleMenu,
  savePreferences,
  syncThemeMenu,
  type Preferences,
} from "./ipc";

const FALLBACK_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Built-in theme choices: "system" plus two token sets each for a light
 *  and a dark base (see styles.css `html[data-theme]` blocks). Shared by
 *  the Preferences dialog select and the View > Theme menu (menu.rs uses
 *  the same ids prefixed with "theme_"). Labels are localized, so this is a
 *  function — recompute after a locale change. */
export function themeChoices(): { value: string; label: string }[] {
  return [
    { value: "system", label: t("preferences.themeSystem") },
    { value: "light", label: t("preferences.themeLight") },
    { value: "dark", label: t("preferences.themeDark") },
    { value: "paper", label: t("preferences.themePaper") },
    { value: "dusk", label: t("preferences.themeDusk") },
  ];
}

/** Language preference choices. "System" is localized (it's a UI concept,
 *  like the theme's "Follow system"); "English" and "繁體中文" are language
 *  endonyms and intentionally not translated — the same convention used by
 *  every OS language picker, so a user can always find their language
 *  regardless of the UI's current language. */
export function languageChoices(): { value: string; label: string }[] {
  return [
    { value: "system", label: t("preferences.langSystemOption") },
    { value: "en", label: "English" },
    { value: "zh-TW", label: "繁體中文" },
  ];
}

let current: Preferences = {
  fontFamily: "",
  fontSize: 13,
  theme: "system",
  language: "system",
  defaultEncoding: "UTF-8",
  defaultBom: false,
  wordWrap: true,
  showInvisibles: false,
  // Default on, unlike showInvisibles: indent guides are a subtle
  // alignment aid (industry convention across VS Code, Sublime, and
  // JetBrains is on-by-default), whereas rendering raw whitespace glyphs
  // is visually noisier and better opt-in.
  indentGuides: true,
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

/** Resolve `current.language` to an effective `Locale`, apply it (updates
 *  `t()` output and `<html lang>`), and best-effort ask the native menu to
 *  relabel itself. Returns the resolved locale. */
function applyLanguage(): Locale {
  const locale = effectiveLocale(current.language);
  setLocale(locale);
  document.documentElement.lang = locale;
  void retitleMenu(locale).catch(() => {
    // Best-effort; the frontend UI is already correct either way.
  });
  return locale;
}

function applyAll(): void {
  applyFont();
  applyTheme();
  const locale = applyLanguage();
  editorRef?.setLineWrapping(current.wordWrap);
  editorRef?.setShowInvisibles(current.showInvisibles);
  editorRef?.setIndentGuides(current.indentGuides);
  editorRef?.setLocale(locale);
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

/** Toggle indent-guide vertical lines (driven by the View menu check
 *  item) and persist. */
export function toggleIndentGuides(): void {
  current.indentGuides = !current.indentGuides;
  editorRef?.setIndentGuides(current.indentGuides);
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
  heading.textContent = t("preferences.extHeading");
  section.appendChild(heading);

  const hint = document.createElement("div");
  hint.className = "prefs-ext-hint";
  hint.textContent = t("preferences.extHint");
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
    ext.placeholder = t("preferences.extPlaceholder");
    ext.value = extension;

    const enc = select(
      reopenEncodingChoices().map((e) => ({ label: e.label, value: e.value })),
    );
    enc.className = "prefs-ext-encoding";
    enc.value = encoding;
    if (enc.selectedIndex < 0) enc.selectedIndex = 0;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "prefs-ext-remove";
    remove.textContent = "✕";
    remove.title = t("preferences.extRemoveTitle");
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
  add.textContent = t("preferences.extAdd");
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
  title.textContent = t("preferences.title");
  dialog.appendChild(title);

  const fontFamily = document.createElement("input");
  fontFamily.type = "text";
  fontFamily.placeholder = t("preferences.editorFontPlaceholder");
  fontFamily.value = current.fontFamily;
  dialog.appendChild(row(t("preferences.editorFont"), fontFamily));

  const fontSize = document.createElement("input");
  fontSize.type = "number";
  fontSize.min = "9";
  fontSize.max = "32";
  fontSize.value = String(current.fontSize);
  dialog.appendChild(row(t("preferences.fontSize"), fontSize));

  const theme = select(themeChoices());
  theme.value = current.theme;
  dialog.appendChild(row(t("preferences.theme"), theme));

  const language = select(languageChoices());
  language.value = current.language;
  if (language.selectedIndex < 0) language.selectedIndex = 0;
  dialog.appendChild(row(t("preferences.language"), language));

  const encoding = select(
    encodingChoices().map((e) => ({
      label: e.label,
      value: `${e.value} ${e.withBom}`,
    })),
  );
  encoding.value = `${current.defaultEncoding} ${current.defaultBom}`;
  if (encoding.selectedIndex < 0) encoding.selectedIndex = 0;
  dialog.appendChild(row(t("preferences.encodingForNewFiles"), encoding));

  const extensions = extensionTable(current.extensionEncodings);
  dialog.appendChild(extensions.element);

  const buttons = document.createElement("div");
  buttons.className = "prefs-buttons";
  const cancel = document.createElement("button");
  cancel.textContent = t("preferences.cancel");
  const save = document.createElement("button");
  save.textContent = t("preferences.save");
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
      language: language.value,
      defaultEncoding: encValue,
      defaultBom: encBom === "true",
      wordWrap: current.wordWrap,
      showInvisibles: current.showInvisibles,
      indentGuides: current.indentGuides,
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
