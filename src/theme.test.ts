// Theme application and persistence (src/preferences.ts). Disk/IPC access
// goes through ./ipc, which is mocked here so these stay pure DOM + state
// tests — see CLAUDE.md "Frontend logic that doesn't need the WebView".
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHandle } from "./editor";
import type { Preferences } from "./ipc";

const loadPreferences = vi.fn<() => Promise<Preferences>>();
const savePreferences = vi.fn<(p: Preferences) => Promise<void>>();
const syncThemeMenu = vi.fn<(theme: string) => Promise<void>>();
const retitleMenu = vi.fn<(locale: string) => Promise<void>>();

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

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc is already mocked by the time preferences.ts is evaluated.
import { initPreferences, preferences, setTheme, themeChoices } from "./preferences";

const fakeEditor = {
  setLineWrapping: vi.fn(),
  setShowInvisibles: vi.fn(),
  setIndentGuides: vi.fn(),
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
    extensionEncodings: [],
    ...overrides,
  };
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  loadPreferences.mockReset();
  savePreferences.mockReset().mockResolvedValue(undefined);
  syncThemeMenu.mockReset().mockResolvedValue(undefined);
  retitleMenu.mockReset().mockResolvedValue(undefined);
});

describe("themeChoices", () => {
  it("lists exactly the five built-in choices, matching menu.rs THEME_IDS", () => {
    expect(themeChoices().map((t) => t.value)).toEqual([
      "system",
      "light",
      "dark",
      "paper",
      "dusk",
    ]);
  });
});

describe("setTheme", () => {
  it("sets html[data-theme] for an explicit theme", () => {
    setTheme("paper");
    expect(document.documentElement.dataset.theme).toBe("paper");

    setTheme("dusk");
    expect(document.documentElement.dataset.theme).toBe("dusk");
  });

  it("clears html[data-theme] for \"system\" so the OS media query wins", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    setTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("persists the change and syncs the native menu's checkmarks", () => {
    setTheme("dusk");
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dusk" }),
    );
    expect(syncThemeMenu).toHaveBeenCalledWith("dusk");
  });
});

describe("initPreferences", () => {
  it("round-trips a persisted theme: load -> apply -> data-theme reflects it", async () => {
    loadPreferences.mockResolvedValue(defaultPreferences({ theme: "paper" }));

    await initPreferences(fakeEditor);

    expect(preferences().theme).toBe("paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("keeps the last-applied theme (never blocks startup) when load fails", async () => {
    // `current` is preferences.ts module state, not reset between tests, so
    // pin a known value first rather than assume a fresh-module default.
    setTheme("dark");
    loadPreferences.mockRejectedValue(new Error("no prefs file yet"));

    await initPreferences(fakeEditor);

    expect(preferences().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
