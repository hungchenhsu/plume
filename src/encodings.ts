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

export interface EncodingChoice {
  label: string;
  value: string;
  withBom: boolean;
}

export function encodingChoices(): EncodingChoice[] {
  return [
    { label: t("encoding.utf8"), value: "UTF-8", withBom: false },
    { label: t("encoding.utf8Bom"), value: "UTF-8", withBom: true },
    { label: t("encoding.utf16le"), value: "UTF-16LE", withBom: true },
    { label: t("encoding.utf16be"), value: "UTF-16BE", withBom: true },
    { label: t("encoding.big5"), value: "Big5", withBom: false },
    { label: t("encoding.gb18030"), value: "gb18030", withBom: false },
    { label: t("encoding.gbk"), value: "GBK", withBom: false },
    { label: t("encoding.shiftJis"), value: "Shift_JIS", withBom: false },
    { label: t("encoding.eucJp"), value: "EUC-JP", withBom: false },
    { label: t("encoding.eucKr"), value: "EUC-KR", withBom: false },
    { label: t("encoding.windows1252"), value: "windows-1252", withBom: false },
    { label: t("encoding.windows1250"), value: "windows-1250", withBom: false },
    { label: t("encoding.windows1251"), value: "windows-1251", withBom: false },
    { label: t("encoding.windows1253"), value: "windows-1253", withBom: false },
    { label: t("encoding.windows1254"), value: "windows-1254", withBom: false },
    { label: t("encoding.windows1255"), value: "windows-1255", withBom: false },
    { label: t("encoding.windows1256"), value: "windows-1256", withBom: false },
    { label: t("encoding.windows1257"), value: "windows-1257", withBom: false },
    { label: t("encoding.windows1258"), value: "windows-1258", withBom: false },
    { label: t("encoding.iso88592"), value: "ISO-8859-2", withBom: false },
    { label: t("encoding.iso88595"), value: "ISO-8859-5", withBom: false },
    { label: t("encoding.iso88597"), value: "ISO-8859-7", withBom: false },
    { label: t("encoding.iso885915"), value: "ISO-8859-15", withBom: false },
    { label: t("encoding.koi8r"), value: "KOI8-R", withBom: false },
    { label: t("encoding.koi8u"), value: "KOI8-U", withBom: false },
    { label: t("encoding.windows874"), value: "windows-874", withBom: false },
    { label: t("encoding.macintosh"), value: "macintosh", withBom: false },
  ];
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
