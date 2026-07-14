//! Representability dry-run for Edit > Normalize to NFC/NFD (ROADMAP.md
//! v0.4 Track A) [danger]: before the frontend ever applies a normalization
//! to the live buffer, check whether the *result* can still be losslessly
//! saved in the document's current encoding.
//!
//! This is the actual point of the whole feature: NFD's decomposed
//! combining sequences are frequently unrepresentable in legacy encodings
//! (Big5, Shift_JIS, ...) even when the precomposed NFC form was fine (a
//! legacy CJK double-byte encoding has no combining diacritical marks at
//! all). Normalizing first and discovering the loss only at save time would
//! be exactly the silent-data-loss path `lib.rs::save_document`'s two-phase
//! lossy gate already exists to prevent for ordinary edits — this dry-run
//! is that same guarantee, applied one step earlier, before the transform
//! is even dispatched into the editor buffer. The frontend's normalize flow
//! (main.ts's `runNormalizeFlow`) calls this after the user confirms the
//! change-count dialog and before ever calling `editor.replaceContent`; if
//! this reports anything unmappable, the frontend shows a second, explicit
//! warning naming the encoding and the count before letting the user
//! proceed — and even then, `save_document`'s own lossy gate still applies
//! at actual save time regardless (defense in depth, not a replacement).
//!
//! Per-character detection technique mirrors `charinspect::encode_char`:
//! `encoding_rs` only reports a single whole-string `had_unmappable` bool
//! for an entire `encode()` call (see `encoding::encode`), never which
//! characters or how many, so each Unicode scalar value in `text` is probed
//! independently via its own single-character `encode()` call. Not the most
//! efficient possible approach, but this only ever runs once per explicit,
//! user-initiated Normalize action — not on any hot path — so O(n) small
//! `encode()` calls is an acceptable trade for reusing exactly the encoding
//! logic `save_document` itself trusts, rather than hand-rolling a second,
//! independent per-encoding unmappable-character table.
//!
//! ROADMAP.md v0.4 Track A "Lossy-save character preview" [danger] reuses
//! this exact scan (the shared `scan_unmappable` below) for
//! `lib.rs::save_document`'s own lossy-rejection path: when a save is
//! rejected because `encoding::encode` reports `unmappable`, `save_document`
//! calls this module's `lossy_save_report` to tell the user *which*
//! characters and *where*, not just that some exist. The two callers differ
//! in exactly one respect -- position: `check_representability`'s dry-run
//! runs against a *plan* that hasn't been applied to the editor buffer yet,
//! so a line/column there wouldn't correspond to anything on screen, while
//! `lossy_save_report` runs against the actual current buffer content, where
//! a position is meaningful and actionable. `scan_unmappable` always tracks
//! position; each public wrapper keeps or discards it.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;

/// Cap on how many *distinct* unmappable characters are actually listed in
/// `RepresentabilityReport::samples` (and, shared via `scan_unmappable`,
/// `LossySaveReport::samples` below). `unmappable_count` itself is never
/// capped — only the sample list — so a document with thousands of
/// unmappable characters doesn't dump them all into a dialog.
const SAMPLE_CAP: usize = 20;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepresentabilityReport {
    /// Total count of Unicode scalar values in the checked text with no
    /// representation in the target encoding — never capped, and counted
    /// per *occurrence* (the actual measure of what a lossy save would
    /// destroy), unlike `samples`, which is per distinct character.
    pub unmappable_count: usize,
    /// Up to `SAMPLE_CAP` formatted samples of *distinct* unmappable
    /// characters, e.g. `"é (U+00E9)"`, in first-encountered order — the
    /// same character occurring many times contributes one entry
    /// (adversarial-review finding: twenty copies of "́ (U+0301)" read as
    /// twenty different problems). Formatted display text, not raw bytes —
    /// the character together with its codepoint, matching
    /// `statusbar.ts`'s `formatCodePoint` "U+XXXX" convention on the
    /// frontend (ARCHITECTURE.md: raw bytes never cross IPC).
    pub samples: Vec<String>,
    /// True when there were more *distinct* unmappable characters than fit
    /// in `samples` — the dialog appends an "and more" note so a capped
    /// list is never mistaken for a complete one. (`unmappable_count`
    /// exceeding `samples.len()` cannot signal this by itself: repeats
    /// make that true even when every distinct character is listed.)
    pub samples_truncated: bool,
}

/// `pub(crate)` so `streamconvert.rs`'s streaming lossy report (ROADMAP.md
/// v0.4 Track B) can format its own samples with the exact same "char
/// (U+XXXX)" convention rather than re-deriving it.
pub(crate) fn format_sample(ch: char) -> String {
    format!("{ch} (U+{:04X})", ch as u32)
}

/// One *distinct* unmappable character sample carrying its first-occurrence
/// position in the scanned text (ROADMAP.md v0.4 Track A "Lossy-save
/// character preview") -- the richer sibling of
/// `RepresentabilityReport::samples`'s plain `String` entries. `line` and
/// `column` are 1-based; `column` counts UTF-16 code units (see
/// `scan_unmappable`'s doc comment), matching the frontend's own CM6-offset-
/// based cursor position that feeds `statusbar.cursor` -- not Unicode
/// scalar values.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnmappableSample {
    /// Formatted display text, identical convention to `format_sample`
    /// (e.g. `"é (U+00E9)"`).
    pub display: String,
    /// 1-based line number of this sample's first occurrence.
    pub line: usize,
    /// 1-based column number of this sample's first occurrence on its line.
    pub column: usize,
}

/// Report attached to `lib.rs::SaveResult` on a lossy-save rejection: same
/// shape as `RepresentabilityReport`, but `samples` carries position
/// (`UnmappableSample`) instead of a plain formatted string, since this
/// scan runs against the buffer actually being saved rather than a
/// not-yet-applied normalization plan.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LossySaveReport {
    /// Total count of Unicode scalar values with no representation in the
    /// target encoding -- never capped, counted per occurrence. Same
    /// semantics as `RepresentabilityReport::unmappable_count`.
    pub unmappable_count: usize,
    /// Up to `SAMPLE_CAP` distinct unmappable characters, in
    /// first-encountered order, each with its own position.
    pub samples: Vec<UnmappableSample>,
    /// True when there were more distinct unmappable characters than fit in
    /// `samples`. Same semantics as
    /// `RepresentabilityReport::samples_truncated`.
    pub samples_truncated: bool,
}

/// One first-encountered unmappable character found by `scan_unmappable`,
/// carrying its 1-based line/column in the scanned text alongside the
/// character itself. Shared internal representation for both public report
/// types below -- `check_representability` discards the position,
/// `lossy_save_report` keeps it (see the module doc for why they differ).
#[derive(Debug)]
pub(crate) struct UnmappableHit {
    pub(crate) ch: char,
    pub(crate) line: usize,
    pub(crate) column: usize,
}

/// Incremental version of the character-by-character scan both
/// `check_representability` and `lossy_save_report` are built from --
/// `scan_unmappable` below is now a thin wrapper that feeds its whole input
/// as a single chunk. Split out (ROADMAP.md v0.4 Track B) so
/// `streamconvert.rs`'s streaming encoding conversion can feed it one
/// already-decoded chunk of a multi-GB file at a time -- never
/// materializing more than one streaming chunk of text at once -- while
/// still producing exactly the same aggregated report (count, up to
/// `SAMPLE_CAP` first-encountered distinct-character samples with position,
/// and a truncated flag) a single whole-string scan would. `feed` may be
/// called any number of times before `finish`; line/column tracking and the
/// sample cap/dedup state carry across calls exactly as if the whole
/// concatenated input had been fed in one call (locked by
/// `chunked_feed_matches_whole_string_scan`).
pub(crate) struct UnmappableScanner {
    encoding: &'static Encoding,
    unmappable_count: usize,
    // Distinct characters already sampled, in first-encountered order. A
    // plain Vec + linear search beats a HashSet here: it caps at SAMPLE_CAP
    // (20) entries, keeps insertion order for free, and the linear scan
    // only runs for characters already known unmappable.
    hits: Vec<UnmappableHit>,
    samples_truncated: bool,
    line: usize,
    column: usize,
}

impl UnmappableScanner {
    pub(crate) fn new(encoding: &'static Encoding) -> Self {
        Self {
            encoding,
            unmappable_count: 0,
            hits: Vec::new(),
            samples_truncated: false,
            line: 1,
            column: 1,
        }
    }

    /// Probe every Unicode scalar value in `text` for representability in
    /// this scanner's encoding exactly like `encoding::encode` does at real
    /// save/normalize time, updating the running count/samples/position
    /// state. `text` need not start or end on any particular boundary
    /// beyond being valid UTF-8 (guaranteed for any `&str`) -- it is simply
    /// the next piece of a larger logical document, decoded text or
    /// otherwise.
    ///
    /// Line/column increment on every `\n` -- callers must feed
    /// LF-normalized text (never a CRLF/CR-converted save buffer) for these
    /// positions to correspond to anything the editor itself shows (see
    /// `lossy_save_report`'s doc comment). Column counts UTF-16 code units,
    /// not Unicode scalar values: this deliberately matches the frontend's
    /// own position convention (CM6's `Text` offsets are UTF-16 code units
    /// -- `editor.ts`'s `onCursorMoved` computes the status bar's "Ln/Col"
    /// the same way, `head - line.from`), so a supplementary-plane
    /// character (e.g. an astral emoji) earlier on the same line advances
    /// the column by 2, not 1 -- otherwise a sample reported as "Col 14"
    /// here could disagree with what the user sees by placing the cursor at
    /// that exact character.
    pub(crate) fn feed(&mut self, text: &str) {
        let mut buf = [0u8; 4];
        for ch in text.chars() {
            let s: &str = ch.encode_utf8(&mut buf);
            let (_, _, had_unmappable) = self.encoding.encode(s);
            if had_unmappable {
                self.unmappable_count += 1;
                if !self.hits.iter().any(|hit| hit.ch == ch) {
                    if self.hits.len() < SAMPLE_CAP {
                        self.hits.push(UnmappableHit {
                            ch,
                            line: self.line,
                            column: self.column,
                        });
                    } else {
                        self.samples_truncated = true;
                    }
                }
            }
            self.advance_position(ch);
        }
    }

    /// Cheaper sibling of [`Self::feed`] for a chunk the caller has already
    /// established (via some cheaper bulk check -- see
    /// `streamconvert.rs::run_convert_loop`) contains *no* unmappable
    /// characters at all: advances line/column tracking the same way `feed`
    /// does, without the per-character `encoding.encode()` representability
    /// probe. Mixing `feed` and `advance_position_only` calls across a
    /// document's chunks in any pattern must produce exactly the same
    /// aggregate result `feed` alone would over the concatenated text, since
    /// position tracking is identical either way and a chunk this is called
    /// on is (by the caller's own precondition) never going to contribute a
    /// hit regardless of which method walks it (locked by
    /// `advance_position_only_then_feed_matches_whole_feed`). Calling this
    /// on a chunk that *does* contain an unmappable character silently
    /// undercounts it -- correctness depends entirely on the caller's
    /// precondition holding.
    pub(crate) fn advance_position_only(&mut self, text: &str) {
        for ch in text.chars() {
            self.advance_position(ch);
        }
    }

    fn advance_position(&mut self, ch: char) {
        if ch == '\n' {
            self.line += 1;
            self.column = 1;
        } else {
            self.column += ch.len_utf16();
        }
    }

    pub(crate) fn finish(self) -> (usize, Vec<UnmappableHit>, bool) {
        (self.unmappable_count, self.hits, self.samples_truncated)
    }
}

/// Whole-string convenience wrapper over [`UnmappableScanner`] for the two
/// callers below, which already have their entire candidate text in memory
/// at once (a not-yet-applied normalization plan, or the actual save
/// buffer) and have no need to feed it in pieces.
fn scan_unmappable(text: &str, encoding: &'static Encoding) -> (usize, Vec<UnmappableHit>, bool) {
    let mut scanner = UnmappableScanner::new(encoding);
    scanner.feed(text);
    scanner.finish()
}

/// Every Unicode scalar value round-trips through UTF-8 and UTF-16 by
/// construction: UTF-8 can encode any scalar value, and UTF-16 can too (as
/// a BMP code unit or a surrogate pair) -- the only code points UTF-16
/// cannot represent are lone surrogates, which Rust's `char` (and therefore
/// `str::chars()`) can never produce in the first place. Shared fast path
/// for both public entry points below: skipping the per-character scan for
/// these targets is correctness-preserving, not just an optimization.
/// `pub(crate)` so `streamconvert.rs` can apply the exact same fast path
/// before ever opening the source file.
pub(crate) fn is_always_representable(encoding: &Encoding) -> bool {
    encoding == UTF_8 || encoding == UTF_16LE || encoding == UTF_16BE
}

/// Core, Tauri-free implementation (unit-testable without the command
/// harness — see the `tests` module below). `label` unknown -> `Err`,
/// matching `encoding::encode`'s own contract.
pub fn check_representability(text: &str, label: &str) -> Result<RepresentabilityReport, String> {
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {label}"))?;

    // The frontend applies the same short-circuit before ever calling the
    // IPC command at all (see main.ts's `runNormalizeFlow` /
    // `isUnicodeEncoding`), but this function agrees independently in case
    // it is ever exercised directly.
    if is_always_representable(encoding) {
        return Ok(RepresentabilityReport {
            unmappable_count: 0,
            samples: Vec::new(),
            samples_truncated: false,
        });
    }

    let (unmappable_count, hits, samples_truncated) = scan_unmappable(text, encoding);
    Ok(RepresentabilityReport {
        unmappable_count,
        samples: hits.into_iter().map(|hit| format_sample(hit.ch)).collect(),
        samples_truncated,
    })
}

/// IPC entry point (src/ipc.ts's `checkRepresentable`). Passes the whole
/// candidate text across the boundary, same cost class as `save_document`'s
/// existing `content` parameter -- see that command's doc comment; this
/// command is read-only and touches no disk.
#[tauri::command]
pub fn check_representable(
    text: String,
    encoding: String,
) -> Result<RepresentabilityReport, String> {
    check_representability(&text, &encoding)
}

/// Called from `lib.rs::save_document`'s lossy-rejection branch (`unmappable
/// && !allow_lossy`) with the same LF-normalized `content` the frontend
/// passed in -- never the line-ending-converted buffer `encoding::encode`
/// actually encodes. This is deliberate, not an oversight: CR/CRLF/LF
/// terminators are always representable in every supported encoding, so the
/// *set* of unmappable characters is identical either way, but a CR-only
/// (classic Mac) converted buffer has no `\n` at all -- scanning it would
/// silently collapse every line into "line 1". Scanning the LF-normalized
/// content keeps positions meaningful against what the editor itself shows.
pub fn lossy_save_report(text: &str, label: &str) -> Result<LossySaveReport, String> {
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {label}"))?;

    if is_always_representable(encoding) {
        return Ok(LossySaveReport {
            unmappable_count: 0,
            samples: Vec::new(),
            samples_truncated: false,
        });
    }

    let (unmappable_count, hits, samples_truncated) = scan_unmappable(text, encoding);
    Ok(LossySaveReport {
        unmappable_count,
        samples: hits
            .into_iter()
            .map(|hit| UnmappableSample {
                display: format_sample(hit.ch),
                line: hit.line,
                column: hit.column,
            })
            .collect(),
        samples_truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_encoding_is_an_error() {
        assert!(check_representability("hello", "not-an-encoding").is_err());
    }

    #[test]
    fn utf8_is_always_fully_representable() {
        // Even wild content (combining marks, emoji, control-adjacent
        // characters) is always representable in UTF-8 -- the fast path
        // must report clean without even inspecting the text.
        let report = check_representability("e\u{0301} 🚀 中文", "UTF-8").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
    }

    #[test]
    fn utf16_is_always_fully_representable() {
        for label in ["UTF-16LE", "UTF-16BE"] {
            let report = check_representability("e\u{0301} 🚀 中文", label).unwrap();
            assert_eq!(report.unmappable_count, 0, "{label}");
            assert!(report.samples.is_empty(), "{label}");
        }
    }

    /// Plain Traditional Chinese text (no diacritics) is fully
    /// representable in Big5 regardless of NFC/NFD -- CJK Unified
    /// Ideographs have no canonical decomposition, so this is the common
    /// case for this app's primary legacy-encoding audience and must not
    /// be flagged.
    #[test]
    fn plain_chinese_text_is_fully_representable_in_big5() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。";
        let report = check_representability(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
    }

    /// The core scenario this whole feature exists to catch (failing-test-
    /// first target): a base character Big5 *can* represent ("e", plain
    /// ASCII) followed by a combining acute accent (U+0301) that Big5
    /// cannot -- Big5 is a legacy CJK double-byte encoding with no
    /// combining diacritical marks in its repertoire at all. This is
    /// exactly what NFD decomposition of an accented Latin letter produces,
    /// so this fixture stands in for "the user normalized to NFD and the
    /// result is no longer representable in the file's Big5 encoding".
    #[test]
    fn nfd_combining_sequence_is_unrepresentable_in_big5() {
        let nfd = "e\u{0301}"; // "e" + combining acute accent
        assert_eq!(nfd.chars().count(), 2);
        let report = check_representability(nfd, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(report.samples, vec!["\u{0301} (U+0301)"]);

        // The precomposed NFC form of the same character -- "é", U+00E9,
        // hand-verified as the canonical composition of "e" + U+0301 -- is
        // *also* unmappable in Big5 (Big5 has no accented Latin at all).
        // This fixture's point is specifically that composing/decomposing
        // changes *which* character is the problem (a lone combining mark
        // vs. a precomposed Latin letter), not that NFC would have avoided
        // representability loss here.
        let nfc_report = check_representability("é", "Big5").unwrap();
        assert_eq!(nfc_report.unmappable_count, 1, "{nfc_report:?}");
    }

    /// Same point as above, phrased the other way: within a longer string
    /// where the base letter is plain ASCII and would encode cleanly on
    /// its own, only the trailing combining mark is unmappable -- the
    /// count and sample must isolate exactly that one character, not the
    /// whole sequence or the whole string.
    #[test]
    fn only_the_combining_mark_is_unmappable_not_the_base_letter() {
        let text = "prefix e\u{0301} suffix"; // ASCII base char + combining mark, embedded
        let report = check_representability(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(report.samples, vec!["\u{0301} (U+0301)"]);
    }

    #[test]
    fn sample_list_is_capped_but_count_is_not() {
        // 30 distinct combining marks (U+0300..=U+031D), all unmappable in
        // Big5, well past SAMPLE_CAP (20).
        let text: String = (0x0300u32..0x0300 + 30)
            .map(|cp| char::from_u32(cp).unwrap())
            .collect();
        let report = check_representability(&text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 30);
        assert_eq!(report.samples.len(), SAMPLE_CAP);
        assert!(
            report.samples_truncated,
            "distinct characters beyond the cap must be flagged"
        );
        // Samples are in first-encountered order.
        assert_eq!(report.samples[0], format_sample('\u{0300}'));
        assert_eq!(
            report.samples[SAMPLE_CAP - 1],
            format_sample(char::from_u32(0x0300 + SAMPLE_CAP as u32 - 1).unwrap())
        );
    }

    /// The truncation flag keys off *distinct* characters, not occurrences:
    /// a count far above `samples.len()` from repeats alone is a complete
    /// list, not a truncated one.
    #[test]
    fn repeats_alone_do_not_set_the_truncated_flag() {
        let text = "e\u{0301}".repeat(50);
        let report = check_representability(&text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 50);
        assert_eq!(report.samples.len(), 1);
        assert!(!report.samples_truncated);
    }

    /// Adversarial-review finding: the same unmappable character repeated
    /// N times must contribute one sample entry, not N identical ones --
    /// the count still reports every occurrence (that is the real measure
    /// of loss), but a dialog listing "́ (U+0301)" twenty times over reads
    /// as twenty different problems.
    #[test]
    fn repeated_unmappable_character_is_sampled_once() {
        let text = "e\u{0301}".repeat(5); // the same combining mark, 5 occurrences
        let report = check_representability(&text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 5, "count is per occurrence");
        assert_eq!(
            report.samples,
            vec!["\u{0301} (U+0301)"],
            "samples are per distinct character"
        );
    }

    #[test]
    fn sample_format_is_char_plus_uppercase_codepoint() {
        assert_eq!(format_sample('é'), "é (U+00E9)");
        assert_eq!(format_sample('\u{0301}'), "́ (U+0301)");
        assert_eq!(format_sample('🚀'), "🚀 (U+1F680)");
    }

    #[test]
    fn shift_jis_also_rejects_combining_marks() {
        // Same underlying invariant as Big5: another legacy CJK
        // double-byte encoding this app supports has no combining
        // diacritical marks either.
        let report = check_representability("e\u{0301}", "Shift_JIS").unwrap();
        assert_eq!(report.unmappable_count, 1);
    }

    #[test]
    fn empty_text_is_trivially_representable() {
        let report = check_representability("", "Big5").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
    }

    // -- lossy_save_report (ROADMAP.md v0.4 Track A "Lossy-save character
    // preview") -- failing-test-first target: the stub above always reports
    // clean, so every test in this section must fail until the real scan
    // (reusing the same technique as `check_representability`, but keeping
    // position) replaces it.

    #[test]
    fn lossy_save_report_unknown_encoding_is_an_error() {
        assert!(lossy_save_report("hello", "not-an-encoding").is_err());
    }

    #[test]
    fn lossy_save_report_utf8_is_always_fully_representable() {
        let report = lossy_save_report("e\u{0301} 🚀 中文", "UTF-8").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
        assert!(!report.samples_truncated);
    }

    #[test]
    fn lossy_save_report_utf16_is_always_fully_representable() {
        for label in ["UTF-16LE", "UTF-16BE"] {
            let report = lossy_save_report("e\u{0301} 🚀 中文", label).unwrap();
            assert_eq!(report.unmappable_count, 0, "{label}");
            assert!(report.samples.is_empty(), "{label}");
        }
    }

    #[test]
    fn plain_chinese_text_is_fully_representable_in_big5_for_save() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
    }

    /// The core scenario this feature exists for: a single unmappable
    /// character embedded in an otherwise-plain-ASCII line must report the
    /// exact 1-based column of its first occurrence, counting UTF-16 code
    /// units to match the status bar's cursor column (this all-BMP fixture
    /// makes the two counts coincide; the UTF-16 semantics themselves are
    /// pinned by `lossy_save_report_counts_columns_in_utf16_units` below)
    /// -- "prefix e◌́ suffix" has the combining acute accent (U+0301) as
    /// its 9th column.
    #[test]
    fn lossy_save_report_reports_first_occurrence_column() {
        let text = "prefix e\u{0301} suffix";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(
            report.samples,
            vec![UnmappableSample {
                display: "\u{0301} (U+0301)".to_string(),
                line: 1,
                column: 9,
            }],
        );
        assert!(!report.samples_truncated);
    }

    /// Multi-line position correctness: the unmappable character sits on
    /// the second of three lines, so `line` must be 2 (1-based), and
    /// `column` must count from the start of *that* line, not the whole
    /// text -- "line two é" has "é" as its 10th character.
    #[test]
    fn lossy_save_report_multiline_position_is_correct() {
        let text = "line one\nline two é\nline three";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(
            report.samples,
            vec![UnmappableSample {
                display: "é (U+00E9)".to_string(),
                line: 2,
                column: 10,
            }],
        );
    }

    /// Emoji (an astral, supplementary-plane character) is a single `char`
    /// in Rust's iteration, so its *own* reported column is unaffected by
    /// how many UTF-16 code units it occupies -- "rocket: 🚀 go" has the
    /// rocket starting at column 9 either way (the column is captured
    /// *before* advancing for the current character).
    #[test]
    fn lossy_save_report_reports_emoji_sample_with_correct_column() {
        let text = "rocket: 🚀 go";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(
            report.samples,
            vec![UnmappableSample {
                display: "🚀 (U+1F680)".to_string(),
                line: 1,
                column: 9,
            }],
        );
    }

    /// The distinguishing case: an astral emoji (UTF-16 length 2) precedes a
    /// second, distinct unmappable character on the same line. If columns
    /// counted Unicode scalar values (`char`s) instead, "é" would land at
    /// column 2; counting UTF-16 code units (matching the frontend's own
    /// CM6-offset-based cursor position -- see `scan_unmappable`'s doc
    /// comment) puts it at column 3, since the rocket alone advances the
    /// column by 2.
    #[test]
    fn lossy_save_report_column_counts_utf16_code_units_not_scalar_values() {
        let text = "\u{1F680}é";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 2, "{report:?}");
        assert_eq!(
            report.samples,
            vec![
                UnmappableSample {
                    display: "🚀 (U+1F680)".to_string(),
                    line: 1,
                    column: 1,
                },
                UnmappableSample {
                    display: "é (U+00E9)".to_string(),
                    line: 1,
                    column: 3,
                },
            ],
        );
    }

    /// A repeated unmappable character must be sampled once, keeping the
    /// position of its *first* occurrence (column 1) even though it also
    /// recurs later (column 7) -- while `unmappable_count` still counts
    /// both occurrences.
    #[test]
    fn lossy_save_report_keeps_first_occurrence_position_on_repeat() {
        let text = "é and é again";
        let report = lossy_save_report(text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 2, "count is per occurrence");
        assert_eq!(
            report.samples,
            vec![UnmappableSample {
                display: "é (U+00E9)".to_string(),
                line: 1,
                column: 1,
            }],
            "samples are per distinct character, at their first position"
        );
    }

    #[test]
    fn lossy_save_report_sample_list_is_capped_but_count_is_not() {
        // 30 distinct combining marks (U+0300..=U+031D), all unmappable in
        // Big5, all on one line -- well past SAMPLE_CAP (20).
        let text: String = (0x0300u32..0x0300 + 30)
            .map(|cp| char::from_u32(cp).unwrap())
            .collect();
        let report = lossy_save_report(&text, "Big5").unwrap();
        assert_eq!(report.unmappable_count, 30);
        assert_eq!(report.samples.len(), SAMPLE_CAP);
        assert!(
            report.samples_truncated,
            "distinct characters beyond the cap must be flagged"
        );
        assert_eq!(report.samples[0].line, 1);
        assert_eq!(report.samples[0].column, 1);
        assert_eq!(report.samples[SAMPLE_CAP - 1].column, SAMPLE_CAP);
    }

    #[test]
    fn lossy_save_report_shift_jis_also_rejects_combining_marks() {
        let report = lossy_save_report("e\u{0301}", "Shift_JIS").unwrap();
        assert_eq!(report.unmappable_count, 1);
        assert_eq!(report.samples[0].line, 1);
        assert_eq!(report.samples[0].column, 2);
    }

    #[test]
    fn lossy_save_report_empty_text_is_trivially_representable() {
        let report = lossy_save_report("", "Big5").unwrap();
        assert_eq!(report.unmappable_count, 0);
        assert!(report.samples.is_empty());
        assert!(!report.samples_truncated);
    }

    /// Locks the actual chunking contract `streamconvert.rs` depends on
    /// (ROADMAP.md v0.4 Track B): feeding the same text through
    /// `UnmappableScanner` in arbitrary pieces must produce exactly the
    /// result a single whole-string `scan_unmappable` call would --
    /// including deduping a repeated character whose first occurrence was
    /// in an earlier chunk, and keeping `samples_truncated` sticky once the
    /// cap is reached partway through a later chunk. Split points are
    /// chosen by *character* index (never a raw byte offset, which could
    /// land mid-character for these 2-byte-in-UTF-8 combining marks and
    /// panic the slice) to isolate this test to the chunking contract
    /// itself, not char-boundary bookkeeping.
    #[test]
    fn chunked_feed_matches_whole_string_scan() {
        let mut text = String::new();
        text.push_str("prefix e\u{0301} middle\n"); // line 1: one distinct hit (U+0301)
                                                    // 25 more distinct combining marks, past SAMPLE_CAP (20), on line 2.
        for cp in 0x0310u32..0x0310 + 25 {
            text.push(char::from_u32(cp).unwrap());
        }
        text.push('\u{0301}'); // repeat of line 1's hit -- must not re-sample
        text.push('\n');
        text.push_str("tail"); // representable, must never appear in any sample

        let (whole_count, whole_hits, whole_truncated) = scan_unmappable(&text, encoding_rs::BIG5);
        assert_eq!(whole_count, 27, "{whole_hits:?}");
        assert!(whole_truncated);
        let whole_hits: Vec<_> = whole_hits
            .into_iter()
            .map(|h| (h.ch, h.line, h.column))
            .collect();

        let boundaries: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
        let n = boundaries.len();
        let split_char_counts: [Vec<usize>; 4] = [
            vec![],
            vec![n / 2],
            vec![n / 4, n / 2],
            vec![1, n / 3, n * 2 / 3, n - 2],
        ];

        for splits in split_char_counts {
            let mut scanner = UnmappableScanner::new(encoding_rs::BIG5);
            let mut last = 0usize;
            for &at in &splits {
                let point = boundaries[at];
                scanner.feed(&text[last..point]);
                last = point;
            }
            scanner.feed(&text[last..]);
            let (count, hits, truncated) = scanner.finish();
            let hits: Vec<_> = hits.into_iter().map(|h| (h.ch, h.line, h.column)).collect();
            assert_eq!(count, whole_count, "splits {splits:?}");
            assert_eq!(hits, whole_hits, "splits {splits:?}");
            assert_eq!(truncated, whole_truncated, "splits {splits:?}");
        }
    }

    /// Locks the exact mixed-call pattern `streamconvert.rs::run_convert_loop`
    /// uses (ROADMAP.md v0.4 Track B): a chunk with no unmappable characters
    /// takes the cheap `advance_position_only` path (skipping the
    /// per-character representability probe), while a chunk that does have
    /// one still goes through the full `feed`. Position tracking must stay
    /// correct across the switch -- an unmappable character in a later
    /// chunk must still report the right line/column even though an
    /// earlier, larger "clean" chunk only ever advanced position, never
    /// probed representability.
    #[test]
    fn advance_position_only_then_feed_matches_whole_feed() {
        let clean_prefix = "plain ASCII line one\nplain ASCII line two\n";
        let dirty_middle = "e\u{0301} has a combining mark\n";
        let clean_suffix = "trailing plain text, no marks here";
        let text = format!("{clean_prefix}{dirty_middle}{clean_suffix}");

        let (whole_count, whole_hits, whole_truncated) = scan_unmappable(&text, encoding_rs::BIG5);
        let whole_hits: Vec<_> = whole_hits
            .into_iter()
            .map(|h| (h.ch, h.line, h.column))
            .collect();

        let mut scanner = UnmappableScanner::new(encoding_rs::BIG5);
        scanner.advance_position_only(clean_prefix);
        scanner.feed(dirty_middle);
        scanner.advance_position_only(clean_suffix);
        let (count, hits, truncated) = scanner.finish();
        let hits: Vec<_> = hits.into_iter().map(|h| (h.ch, h.line, h.column)).collect();

        assert_eq!(count, whole_count);
        assert_eq!(hits, whole_hits);
        assert_eq!(truncated, whole_truncated);
        assert_eq!(count, 1, "exactly the one combining mark in dirty_middle");
        assert_eq!(hits[0].1, 3, "dirty_middle starts on line 3");
    }
}
