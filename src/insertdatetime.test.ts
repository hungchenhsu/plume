import { describe, expect, it } from "vitest";
import type { Locale } from "./i18n";
import { formatInsertDateTime } from "./insertdatetime";

const LOCALES: Locale[] = ["en", "zh-TW", "ja", "zh-CN"];

// Fixed instant so the assertions below don't race the wall clock — see
// formatInsertDateTime's doc comment for why `date` is injected at all.
const FIXED_DATE = new Date(2026, 6, 19, 14, 5, 0);

describe("formatInsertDateTime", () => {
  // Never assert the exact formatted string: Intl's ICU-backed output
  // varies by platform and ICU version (this project's Tier 1 targets are
  // both macOS and Windows, each bundling its own ICU) — only that the
  // result looks like a real, fully-formed date/time, not empty, not a
  // decode-style failure marker.
  it.each(LOCALES)("returns a non-empty, year-bearing string for locale %s", (locale) => {
    const result = formatInsertDateTime(locale, FIXED_DATE);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/2026/);
    expect(result).not.toMatch(/invalid date/i);
  });

  it("reflects the injected date, not the current wall-clock time", () => {
    const early = formatInsertDateTime("en", new Date(2020, 0, 1, 0, 0, 0));
    const late = formatInsertDateTime("en", new Date(2030, 11, 31, 23, 59, 0));
    expect(early).not.toBe(late);
    expect(early).toMatch(/2020/);
    expect(late).toMatch(/2030/);
  });

  it("never throws for any supported locale", () => {
    for (const locale of LOCALES) {
      expect(() => formatInsertDateTime(locale, FIXED_DATE)).not.toThrow();
    }
  });
});
