// Preferences dialog Save button (src/preferences.ts showPreferencesDialog).
// Disk/IPC access goes through ./ipc and the native dialog plugin, both
// mocked here so this stays a pure DOM + state test — see CLAUDE.md
// "Frontend logic that doesn't need the WebView". Covers the v0.6 V2
// IPC-error-surfacing fix (audit #4): a failed savePreferences must not
// close the dialog as if the write succeeded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHandle } from "./editor";
import type { Preferences } from "./ipc";

const loadPreferences = vi.fn<() => Promise<Preferences>>();
const savePreferences = vi.fn<(p: Preferences) => Promise<void>>();
const syncThemeMenu = vi.fn<(theme: string) => Promise<void>>();
const retitleMenu = vi.fn<(locale: string) => Promise<void>>();
const messageDialog = vi.fn<(msg: string, opts?: unknown) => Promise<void>>();

vi.mock("./ipc", () => ({
  loadPreferences: (...args: unknown[]) =>
    (loadPreferences as (...a: unknown[]) => unknown)(...args),
  savePreferences: (...args: unknown[]) =>
    (savePreferences as (...a: unknown[]) => unknown)(...args),
  syncThemeMenu: (...args: unknown[]) =>
    (syncThemeMenu as (...a: unknown[]) => unknown)(...args),
  retitleMenu: (...args: unknown[]) =>
    (retitleMenu as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) =>
    (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// preferences.ts is evaluated (same pattern as theme.test.ts).
import { initPreferences, showPreferencesDialog } from "./preferences";

const fakeEditor = {
  setLineWrapping: vi.fn(),
  setShowInvisibles: vi.fn(),
  setIndentGuides: vi.fn(),
  setSuspiciousChars: vi.fn(),
  setLocale: vi.fn(),
} as unknown as EditorHandle;

function defaultPreferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    fontFamily: "",
    fontSize: 13,
    theme: "system",
    language: "system",
    defaultEncoding: "UTF-8",
    defaultBom: false,
    wordWrap: true,
    showInvisibles: false,
    indentGuides: true,
    suspiciousChars: true,
    indentWidth: 4,
    extensionEncodings: [],
    ...overrides,
  };
}

// Lets a click handler's internal `await`s (savePreferences, then either
// close() or messageDialog()) settle before assertions run.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(async () => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
  loadPreferences.mockReset().mockResolvedValue(defaultPreferences());
  savePreferences.mockReset().mockResolvedValue(undefined);
  syncThemeMenu.mockReset().mockResolvedValue(undefined);
  retitleMenu.mockReset().mockResolvedValue(undefined);
  messageDialog.mockReset().mockResolvedValue(undefined);
  await initPreferences(fakeEditor);
});

describe("showPreferencesDialog Save button", () => {
  it("applies and persists on success, then closes the dialog", async () => {
    showPreferencesDialog();
    expect(document.querySelector(".prefs-overlay")).not.toBeNull();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".prefs-overlay")).toBeNull();
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and surfaces the error when the save fails", async () => {
    savePreferences.mockRejectedValue(new Error("disk full"));
    showPreferencesDialog();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // Not closed: a silent close here would tell the user the settings
    // were saved when the write actually failed.
    expect(document.querySelector(".prefs-overlay")).not.toBeNull();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog).toHaveBeenCalledWith(
      "Error: disk full",
      expect.objectContaining({ title: "Preferences save failed", kind: "error" }),
    );

    // Retrying (e.g. after fixing the underlying problem) still works from
    // the same, still-open dialog.
    savePreferences.mockResolvedValue(undefined);
    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();
    expect(document.querySelector(".prefs-overlay")).toBeNull();
  });

  it("still applies settings to the live UI even when persistence fails", async () => {
    savePreferences.mockRejectedValue(new Error("disk full"));
    showPreferencesDialog();

    const fontSizeInput = document.querySelector<HTMLInputElement>(
      ".prefs-dialog input[type='number']",
    )!;
    fontSizeInput.value = "20";
    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // applyAll() ran before the failed savePreferences — same "apply now,
    // persist best-effort" contract as the ambient toggles.
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe(
      "20px",
    );
  });

  it("does not touch syncThemeMenu's own best-effort failure handling", async () => {
    savePreferences.mockResolvedValue(undefined);
    syncThemeMenu.mockRejectedValue(new Error("menu unavailable"));
    showPreferencesDialog();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // syncThemeMenu's rejection stays swallowed by its own .catch(), not
    // routed through the new error path — only savePreferences failures
    // keep the dialog open.
    expect(document.querySelector(".prefs-overlay")).toBeNull();
    expect(messageDialog).not.toHaveBeenCalled();
  });
});
