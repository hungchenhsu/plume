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

  it("resolves zh-HK and zh-MO to zh-TW", () => {
    expect(resolveSystemLocale("zh-HK")).toBe("zh-TW");
    expect(resolveSystemLocale("zh-MO")).toBe("zh-TW");
  });

  it("resolves zh-CN to zh-CN", () => {
    expect(resolveSystemLocale("zh-CN")).toBe("zh-CN");
  });

  it("resolves zh-Hans and zh-Hans-CN to zh-CN (Hans variant)", () => {
    expect(resolveSystemLocale("zh-Hans")).toBe("zh-CN");
    expect(resolveSystemLocale("zh-Hans-CN")).toBe("zh-CN");
  });

  it("resolves zh-SG to zh-CN", () => {
    expect(resolveSystemLocale("zh-SG")).toBe("zh-CN");
  });

  it("resolves a bare zh with no script/region hint to en", () => {
    expect(resolveSystemLocale("zh")).toBe("en");
  });

  it("resolves en-US to en", () => {
    expect(resolveSystemLocale("en-US")).toBe("en");
  });

  it("resolves ja and ja-JP to ja", () => {
    expect(resolveSystemLocale("ja")).toBe("ja");
    expect(resolveSystemLocale("ja-JP")).toBe("ja");
  });

  it("resolves a missing/empty tag to en", () => {
    expect(resolveSystemLocale(undefined)).toBe("en");
    expect(resolveSystemLocale(null)).toBe("en");
    expect(resolveSystemLocale("")).toBe("en");
  });

  it("is case-insensitive", () => {
    expect(resolveSystemLocale("ZH-TW")).toBe("zh-TW");
    expect(resolveSystemLocale("ZH-CN")).toBe("zh-CN");
    expect(resolveSystemLocale("JA-JP")).toBe("ja");
  });
});

describe("effectiveLocale", () => {
  it("returns the explicit locale for 'en' and 'zh-TW'", () => {
    expect(effectiveLocale("en")).toBe("en");
    expect(effectiveLocale("zh-TW")).toBe("zh-TW");
  });

  it("returns the explicit locale for 'ja' and 'zh-CN'", () => {
    expect(effectiveLocale("ja")).toBe("ja");
    expect(effectiveLocale("zh-CN")).toBe("zh-CN");
  });

  it("resolves 'system' via the given system tag", () => {
    expect(effectiveLocale("system", "zh-TW")).toBe("zh-TW");
    expect(effectiveLocale("system", "en-US")).toBe("en");
    expect(effectiveLocale("system", "ja-JP")).toBe("ja");
    expect(effectiveLocale("system", "zh-CN")).toBe("zh-CN");
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

  it("switches output to ja after setLocale", () => {
    setLocale("ja");
    expect(t("statusbar.noFile")).toBe("ファイルなし");
    expect(t("statusbar.cursor", 3, 7)).toBe("行 3、列 7");
  });

  it("switches output to zh-CN after setLocale", () => {
    setLocale("zh-CN");
    expect(t("statusbar.noFile")).toBe("无文件");
    expect(t("statusbar.cursor", 3, 7)).toBe("第 3 行，第 7 列");
  });

  it("pluralizes each noun in statusbar.textStats independently (English only)", () => {
    expect(t("statusbar.textStats", 1, 1, 1)).toBe("1 word, 1 char, 1 line");
    expect(t("statusbar.textStats", 2, 1, 1)).toBe("2 words, 1 char, 1 line");
    expect(t("statusbar.textStats", 120, 800, 12)).toBe("120 words, 800 chars, 12 lines");
  });

  it("prefixes statusbar.textStatsSelection distinctly from the whole-document phrasing", () => {
    expect(t("statusbar.textStatsSelection", 1, 1, 1)).toBe("Selected: 1 word, 1 char, 1 line");
  });

  it("does not inflect statusbar.textStats for count in zh-TW/ja/zh-CN", () => {
    setLocale("zh-TW");
    expect(t("statusbar.textStats", 1, 1, 1)).toBe("1 詞、1 字元、1 行");
    setLocale("ja");
    expect(t("statusbar.textStats", 1, 1, 1)).toBe("1 語、1 文字、1 行");
    setLocale("zh-CN");
    expect(t("statusbar.textStats", 1, 1, 1)).toBe("1 词、1 字符、1 行");
  });

  // ROADMAP.md v0.4 Track A Unicode normalization [danger]: the
  // representability warning's sample list is capped and deduplicated
  // (src-tauri/src/normalize.rs's SAMPLE_CAP / distinct-character
  // sampling) while its count never is — the message must never imply a
  // capped list is exhaustive, and must not bolt a note onto a complete
  // one (a count above samples.length from repeats alone is complete).
  it("appends an and-more note to dialog.normalizeUnrepresentableMessage only when the sample list is truncated", () => {
    const samples = ["a (U+0061)", "b (U+0062)"];
    const capped = t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, true);
    expect(capped).toContain("a (U+0061), b (U+0062) and more");
    // Repeats alone: count 25, two distinct samples, nothing truncated.
    const complete = t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, false);
    expect(complete).not.toContain("and more");
    expect(complete).toContain("25 characters");

    setLocale("zh-TW");
    expect(t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, true)).toContain(
      "b (U+0062) 等。",
    );
    expect(t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, false)).not.toContain(
      "等。",
    );
    setLocale("ja");
    expect(t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, true)).toContain(
      "など。",
    );
    setLocale("zh-CN");
    expect(t("dialog.normalizeUnrepresentableMessage", "Big5", 25, samples, true)).toContain(
      "b (U+0062) 等。",
    );
  });
});

describe("getLocale / setLocale / onLocaleChange", () => {
  it("getLocale reflects the last setLocale call", () => {
    setLocale("zh-TW");
    expect(getLocale()).toBe("zh-TW");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("getLocale reflects ja and zh-CN too", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
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
