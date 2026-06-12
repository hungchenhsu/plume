// Curated encoding choices for the status bar pickers. `value` must be a
// canonical encoding_rs name so it round-trips with what the Rust core
// reports back after detection.
export interface EncodingChoice {
  label: string;
  value: string;
  withBom: boolean;
}

export const ENCODINGS: EncodingChoice[] = [
  { label: "UTF-8", value: "UTF-8", withBom: false },
  { label: "UTF-8 with BOM", value: "UTF-8", withBom: true },
  { label: "UTF-16 LE", value: "UTF-16LE", withBom: true },
  { label: "UTF-16 BE", value: "UTF-16BE", withBom: true },
  { label: "Big5 (Traditional Chinese)", value: "Big5", withBom: false },
  { label: "GB18030 (Simplified Chinese)", value: "gb18030", withBom: false },
  { label: "GBK (Simplified Chinese)", value: "GBK", withBom: false },
  { label: "Shift_JIS (Japanese)", value: "Shift_JIS", withBom: false },
  { label: "EUC-JP (Japanese)", value: "EUC-JP", withBom: false },
  { label: "EUC-KR (Korean)", value: "EUC-KR", withBom: false },
  { label: "Windows-1252 (Western)", value: "windows-1252", withBom: false },
];

/** Choices for reopening: BOM variants collapse into their base encoding. */
export const REOPEN_ENCODINGS: EncodingChoice[] = ENCODINGS.filter(
  (e) => !(e.value === "UTF-8" && e.withBom),
);
