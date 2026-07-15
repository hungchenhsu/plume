// Curated encoding choices for the status bar pickers. `value` must be a
// canonical encoding_rs name so it round-trips with what the Rust core
// reports back after detection. Labels are localized, so these are built by
// a function (not a static const) and must be recomputed after a locale
// change — see main.ts's onLocaleChange subscription.
//
// Sync mirror (ROADMAP.md v0.5 Track E1): src-tauri/src/fuzz_roundtrip.rs's
// `ALL_ENCODING_LABELS` constant lists these same `value`s (the UTF-8-with-
// BOM variant collapsed into plain "UTF-8", since it's the same underlying
// `Encoding`), and that file's `frontend_whitelist_labels_resolve_and_are_
// ascii_compatible_or_utf16` test asserts every one resolves via
// `Encoding::for_label` and is ASCII-compatible (UTF-16LE/BE exempted from
// that half by name). Neither list is generated from the other — no shared
// build-script/JSON source exists yet (evaluated when this list grew from
// 11 to 27 entries and judged not worth the added build complexity at this
// size; revisit if it keeps growing) — so adding/removing/renaming a choice
// here must be mirrored there by hand, and vice versa.
//
// Deliberately excluded, and must stay excluded:
// - ISO-2022-JP: the one *stateful* encoding `encoding_rs` implements
//   (shift-mode escape sequences, not reset at line boundaries). Several
//   byte-level fast paths elsewhere in this app (replaceinfiles.rs's line-
//   level passthrough, streamreplace.rs's chunk passthrough) assume every
//   supported encoding is stateless and ASCII-compatible; offering this
//   encoding here would let a user pick one whose own shift state those
//   fast paths can silently desynchronize and corrupt (see
//   .claude/judgment-overlay.md §4's ISO-2022-JP lesson).
// - x-user-defined: not a real text encoding (raw high bytes are mapped
//   1:1 into a PUA range) — nothing a user would ever choose to open/save
//   ordinary text as.
// - replacement: WHATWG's error-signaling pseudo-encoding. Never a valid
//   decode/encode target, and `encoding_rs` never auto-detects it either.
import { t } from "./i18n";

// Group taxonomy for the picker UX (ROADMAP.md v0.5 Track E2): once E1 grew
// the flat list to 27 entries, scanning it became the bottleneck, so choices
// are bucketed into a handful of groups a user can recognize at a glance.
// This is a *mental-model* grouping, not a linguistically rigorous charset
// classification — e.g. "Other" is deliberately a catch-all for anything
// that isn't Unicode/East Asian/Western/Central European/Cyrillic, rather
// than its own coherent family (it mixes Greek, Turkish, Hebrew, Arabic,
// Baltic, Vietnamese, Thai and Mac Roman). `ENCODING_GROUP_ORDER` is the
// single source of truth for display order — both `groupEncodingChoices`
// and any consumer that needs to enumerate groups should derive from it
// rather than hard-coding a second copy of the sequence.
export type EncodingGroupId =
  | "unicode"
  | "eastAsian"
  | "westernEuropean"
  | "centralEuropean"
  | "cyrillic"
  | "other";

export const ENCODING_GROUP_ORDER: readonly EncodingGroupId[] = [
  "unicode",
  "eastAsian",
  "westernEuropean",
  "centralEuropean",
  "cyrillic",
  "other",
];

/** Localized group header labels, recomputed per call like `encodingChoices`
 *  itself (see that function's doc comment) — must not be hoisted to a
 *  module-level const, or it would freeze at whatever locale was active on
 *  first import. Returning a `Record<EncodingGroupId, string>` (rather than
 *  a switch) makes a missing/extra case a compile error for free. */
function encodingGroupLabels(): Record<EncodingGroupId, string> {
  return {
    unicode: t("encoding.group.unicode"),
    eastAsian: t("encoding.group.eastAsian"),
    westernEuropean: t("encoding.group.westernEuropean"),
    centralEuropean: t("encoding.group.centralEuropean"),
    cyrillic: t("encoding.group.cyrillic"),
    other: t("encoding.group.other"),
  };
}

export interface EncodingChoice {
  label: string;
  value: string;
  withBom: boolean;
  /** Omitted for pseudo-choices that aren't a real charset family (e.g.
   *  batchconvert.ts's "keep current encoding" sentinel) — `groupEncodingChoices`
   *  skips entries with no group, leaving the caller to render them outside
   *  the grouped section. Every entry `encodingChoices()` itself produces
   *  sets this. */
  group?: EncodingGroupId;
}

export interface EncodingChoiceGroup {
  id: EncodingGroupId;
  label: string;
  choices: EncodingChoice[];
}

/**
 * Buckets `choices` by `.group` into `EncodingChoiceGroup`s ordered per
 * `ENCODING_GROUP_ORDER`, preserving each group's relative internal order.
 * A group absent from `choices` (e.g. streamConvertEncodingChoices() drops
 * both UTF-16 targets, but not the rest of Unicode) is omitted rather than
 * emitted empty. Entries with no `group` are skipped — see `EncodingChoice.
 * group`'s doc comment.
 */
export function groupEncodingChoices(choices: EncodingChoice[]): EncodingChoiceGroup[] {
  const labels = encodingGroupLabels();
  const byGroup = new Map<EncodingGroupId, EncodingChoice[]>();
  for (const choice of choices) {
    if (!choice.group) continue;
    const bucket = byGroup.get(choice.group);
    if (bucket) bucket.push(choice);
    else byGroup.set(choice.group, [choice]);
  }
  return ENCODING_GROUP_ORDER.filter((id) => byGroup.has(id)).map((id) => ({
    id,
    label: labels[id],
    choices: byGroup.get(id)!,
  }));
}

/** `groupEncodingChoices(encodingChoices())` — the grouped view of the full
 *  27-entry catalog, for menu/select consumers that don't otherwise need a
 *  filtered subset (reopen/streamConvert/etc. call `groupEncodingChoices`
 *  directly on their own filtered list instead). */
export function groupedEncodingChoices(): EncodingChoiceGroup[] {
  return groupEncodingChoices(encodingChoices());
}

export function encodingChoices(): EncodingChoice[] {
  return [
    { label: t("encoding.utf8"), value: "UTF-8", withBom: false, group: "unicode" },
    { label: t("encoding.utf8Bom"), value: "UTF-8", withBom: true, group: "unicode" },
    { label: t("encoding.utf16le"), value: "UTF-16LE", withBom: true, group: "unicode" },
    { label: t("encoding.utf16be"), value: "UTF-16BE", withBom: true, group: "unicode" },
    { label: t("encoding.big5"), value: "Big5", withBom: false, group: "eastAsian" },
    { label: t("encoding.gb18030"), value: "gb18030", withBom: false, group: "eastAsian" },
    { label: t("encoding.gbk"), value: "GBK", withBom: false, group: "eastAsian" },
    { label: t("encoding.shiftJis"), value: "Shift_JIS", withBom: false, group: "eastAsian" },
    { label: t("encoding.eucJp"), value: "EUC-JP", withBom: false, group: "eastAsian" },
    { label: t("encoding.eucKr"), value: "EUC-KR", withBom: false, group: "eastAsian" },
    {
      label: t("encoding.windows1252"),
      value: "windows-1252",
      withBom: false,
      group: "westernEuropean",
    },
    {
      label: t("encoding.windows1250"),
      value: "windows-1250",
      withBom: false,
      group: "centralEuropean",
    },
    { label: t("encoding.windows1251"), value: "windows-1251", withBom: false, group: "cyrillic" },
    { label: t("encoding.windows1253"), value: "windows-1253", withBom: false, group: "other" },
    { label: t("encoding.windows1254"), value: "windows-1254", withBom: false, group: "other" },
    { label: t("encoding.windows1255"), value: "windows-1255", withBom: false, group: "other" },
    { label: t("encoding.windows1256"), value: "windows-1256", withBom: false, group: "other" },
    { label: t("encoding.windows1257"), value: "windows-1257", withBom: false, group: "other" },
    { label: t("encoding.windows1258"), value: "windows-1258", withBom: false, group: "other" },
    {
      label: t("encoding.iso88592"),
      value: "ISO-8859-2",
      withBom: false,
      group: "centralEuropean",
    },
    { label: t("encoding.iso88595"), value: "ISO-8859-5", withBom: false, group: "cyrillic" },
    { label: t("encoding.iso88597"), value: "ISO-8859-7", withBom: false, group: "other" },
    {
      label: t("encoding.iso885915"),
      value: "ISO-8859-15",
      withBom: false,
      group: "westernEuropean",
    },
    { label: t("encoding.koi8r"), value: "KOI8-R", withBom: false, group: "cyrillic" },
    { label: t("encoding.koi8u"), value: "KOI8-U", withBom: false, group: "cyrillic" },
    { label: t("encoding.windows874"), value: "windows-874", withBom: false, group: "other" },
    { label: t("encoding.macintosh"), value: "macintosh", withBom: false, group: "other" },
  ];
}

// Detection-boundary classification (ROADMAP.md v0.5 Track E3): which of
// the 27 catalog values chardetng's *statistical* guess (`detector.guess()`
// in src-tauri/src/encoding.rs) can never itself produce, so opening a file
// as one of these always required a BOM, a per-extension default, or a
// manual "Reopen with Encoding" — never a bare content scan. Verified
// against chardetng 0.1.17 (the version `Cargo.lock` pins) itself, not
// assumed from encoding age or byte width — see its README's "Notes About
// Encodings" section: https://github.com/hsivonen/chardetng/blob/master/README.md
//
// - "ISO-8859-15" and "macintosh" are listed under "Not detected" outright:
//   "These encodings have never been a locale-specific fallback in a major
//   browser or a menu item in IE."
// - "gb18030" is listed as "Detected as GBK": the underlying Chinese
//   multi-byte statistical family IS recognized, but `guess()` can only
//   ever return the distinct `GBK` `Encoding`, never `gb18030` — so
//   `detect_with_extension`'s reason=detector path can set `chosen` to GBK,
//   but literally never to gb18030.
// - "KOI8-R" is listed as "Detected as KOI8-U", for the identical reason
//   ("Always guessing the U variant is less likely to corrupt non-box
//   drawing characters.") — the guess always comes back labeled KOI8-U.
//
// Every *other* single-byte family this catalog offers — windows-1250
// through windows-1258, windows-874, ISO-8859-2/5/7, KOI8-U — IS a genuine
// chardetng detection target and is deliberately absent from this set, even
// though it shares the "legacy single-byte" shape with the four above.
// (windows-1257 and windows-874 do carry accuracy caveats in the same
// README — "very inaccurate" and poor on short input, respectively — but
// chardetng does attempt them, unlike the four below, so they stay out of
// this boolean set; see docs/encoding-detection.md for the accuracy notes.)
//
// UTF-16LE/UTF-16BE are also outside chardetng's own target set
// ("Detecting these belongs on the BOM layer") but are deliberately
// excluded from this set: this app's BOM-sniffing layer (`Encoding::
// for_bom`, checked before chardetng in `detect_with_extension`) detects
// them automatically whenever a BOM is present — the overwhelmingly common
// case for real UTF-16 files — so calling them "manual-only" here would
// overstate the gap the detectcard.ts note built on this set describes.
export const MANUAL_ONLY_ENCODINGS: ReadonlySet<string> = new Set([
  "gb18030",
  "ISO-8859-15",
  "KOI8-R",
  "macintosh",
]);

/** Whether `value` (a canonical encoding_rs name, as used throughout this
 *  module) is one chardetng's content-based auto-detect can never itself
 *  choose — see `MANUAL_ONLY_ENCODINGS`'s doc comment for the verified
 *  evidence. Drives detectcard.ts's detection-boundary note. */
export function isManualOnlyEncoding(value: string): boolean {
  return MANUAL_ONLY_ENCODINGS.has(value);
}

/** Choices for reopening: BOM variants collapse into their base encoding. */
export function reopenEncodingChoices(): EncodingChoice[] {
  return encodingChoices().filter((e) => !(e.value === "UTF-8" && e.withBom));
}

/** Choices for the truncated large-file "Convert File to Encoding" flow
 *  (ROADMAP.md v0.4 Track B, streamconvert.ts): UTF-16 targets excluded,
 *  since streamconvert.rs's `stream_convert_file` rejects them outright (no
 *  real `encoding_rs` UTF-16 encoder — see that module's doc comment). A
 *  UTF-16 *source* is unaffected by this list; it's only ever passed as
 *  `sourceEncoding`, never chosen from here. Each remaining choice already
 *  carries its own correct `withBom` (e.g. plain "UTF-8" is `withBom:
 *  false`), so picking one *is* how the BOM decision is made — there is no
 *  separate default to compute here. */
export function streamConvertEncodingChoices(): EncodingChoice[] {
  return encodingChoices().filter((e) => e.value !== "UTF-16LE" && e.value !== "UTF-16BE");
}
