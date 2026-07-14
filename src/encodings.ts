// Curated encoding choices for the status bar pickers. `value` must be a
// canonical encoding_rs name so it round-trips with what the Rust core
// reports back after detection. Labels are localized, so these are built by
// a function (not a static const) and must be recomputed after a locale
// change — see main.ts's onLocaleChange subscription.
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
