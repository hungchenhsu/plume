import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveLocale,
  getLocale,
  onLocaleChange,
  resolveSystemLocale,
  setLocale,
  t,
} from "./i18n";

// Every test that calls setLocale must restore the default so later tests
// (and other test files sharing this module instance) see English again.
afterEach(() => {
  setLocale("en");
});

describe("resolveSystemLocale", () => {
  it("resolves zh-TW to zh-TW", () => {
    expect(resolveSystemLocale("zh-TW")).toBe("zh-TW");
  });

  it("resolves zh-Hant-TW to zh-TW (Hant variant)", () => {
    expect(resolveSystemLocale("zh-Hant-TW")).toBe("zh-TW");
  });

  it("resolves zh-CN to en (no Simplified Chinese dictionary)", () => {
    expect(resolveSystemLocale("zh-CN")).toBe("en");
  });

  it("resolves en-US to en", () => {
    expect(resolveSystemLocale("en-US")).toBe("en");
  });

  it("resolves ja-JP to en (unsupported language falls back)", () => {
    expect(resolveSystemLocale("ja-JP")).toBe("en");
  });

  it("resolves a missing/empty tag to en", () => {
    expect(resolveSystemLocale(undefined)).toBe("en");
    expect(resolveSystemLocale(null)).toBe("en");
    expect(resolveSystemLocale("")).toBe("en");
  });

  it("is case-insensitive", () => {
    expect(resolveSystemLocale("ZH-TW")).toBe("zh-TW");
  });
});

describe("effectiveLocale", () => {
  it("returns the explicit locale for 'en' and 'zh-TW'", () => {
    expect(effectiveLocale("en")).toBe("en");
    expect(effectiveLocale("zh-TW")).toBe("zh-TW");
  });

  it("resolves 'system' via the given system tag", () => {
    expect(effectiveLocale("system", "zh-TW")).toBe("zh-TW");
    expect(effectiveLocale("system", "en-US")).toBe("en");
  });

  it("falls back to system resolution for an unrecognized preference value", () => {
    expect(effectiveLocale("bogus", "zh-Hant-TW")).toBe("zh-TW");
  });
});

describe("t", () => {
  it("returns the plain-string entry unchanged", () => {
    expect(t("statusbar.noFile")).toBe("No file");
  });

  it("interpolates a single parameter", () => {
    expect(t("dialog.pagingTitle")).toBe("Paging");
    expect(t("app.untitledNumbered", 2)).toBe("Untitled-2");
  });

  it("interpolates multiple parameters in order", () => {
    expect(t("statusbar.cursor", 3, 7)).toBe("Ln 3, Col 7");
    expect(t("detectcard.sampledPartial", "64 KB", "200 KB")).toBe(
      "first 64 KB of 200 KB",
    );
  });

  it("switches output after setLocale", () => {
    setLocale("zh-TW");
    expect(t("statusbar.noFile")).toBe("無檔案");
    expect(t("statusbar.cursor", 3, 7)).toBe("第 3 行，第 7 欄");
  });
});

describe("getLocale / setLocale / onLocaleChange", () => {
  it("getLocale reflects the last setLocale call", () => {
    setLocale("zh-TW");
    expect(getLocale()).toBe("zh-TW");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("notifies subscribers only on an actual change", () => {
    let calls = 0;
    const unsubscribe = onLocaleChange(() => {
      calls += 1;
    });
    try {
      setLocale("en"); // already "en" after the outer afterEach — no-op
      expect(calls).toBe(0);
      setLocale("zh-TW");
      expect(calls).toBe(1);
      setLocale("zh-TW"); // no-op, same locale
      expect(calls).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = onLocaleChange(() => {
      calls += 1;
    });
    unsubscribe();
    setLocale("zh-TW");
    expect(calls).toBe(0);
  });
});
