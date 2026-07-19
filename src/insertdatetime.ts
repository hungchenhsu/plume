// ROADMAP.md v0.7 Track C stretch: Edit menu / Command Palette "Insert
// Date/Time" (menu.rs's insert_datetime id, main.ts's dispatchMenuCommand,
// editor.ts's insertTextAtCursor). This module owns only the formatting —
// a pure function, unit-testable without a live EditorView, same reasoning
// as lineops.ts's transforms.
//
// No custom format preference: the spec is deliberately narrow (a single
// standard, locale-appropriate rendering), not a strftime-style picker —
// see ROADMAP.md's own item text.

import type { Locale } from "./i18n";

/**
 * Format `date` as a single localized "date + time" string for insertion at
 * the cursor, via the platform's own `Intl.DateTimeFormat` rather than a
 * hand-built pattern — `dateStyle: "medium"` + `timeStyle: "short"` is the
 * standard "readable, locale-appropriate, not overly long" combination
 * (e.g. MDN's and TC39's own introductory examples for this API use the
 * same pair).
 *
 * `locale` takes `i18n.ts`'s own `Locale` type directly rather than a
 * separate mapping table: every value it can hold ("en" | "zh-TW" | "ja" |
 * "zh-CN") is already a valid BCP-47 language tag `Intl.DateTimeFormat`
 * accepts as-is, with no extra region/script inference needed the way
 * menu.rs's own OS-locale resolution requires for a raw system tag.
 *
 * Example output (this project's dev machine, Node/ICU, 2026-07-19 14:05
 * local) — see insertdatetime.test.ts for why the tests below assert shape
 * rather than these exact strings (punctuation/spacing can drift across
 * ICU versions and OSes, e.g. macOS vs. Windows' bundled ICU):
 *   en:    "Jul 19, 2026, 2:05 PM"
 *   zh-TW: "2026年7月19日 下午2:05"
 *   ja:    "2026/07/19 14:05"
 *   zh-CN: "2026年7月19日 14:05"
 *
 * `date` is injected rather than read internally via `new Date()` purely so
 * the caller (main.ts) supplies "now" once at dispatch time and tests can
 * pin a fixed instant instead of racing the wall clock.
 */
export function formatInsertDateTime(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
