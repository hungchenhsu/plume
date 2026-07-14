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

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;

/// Cap on how many *distinct* unmappable characters are actually listed in
/// `RepresentabilityReport::samples`. `unmappable_count` itself is never
/// capped — only the sample list — mirroring the capped-sample spirit of
/// ROADMAP.md's forthcoming "Lossy-save character preview" item (listing
/// *which* characters can't be encoded, not just a count, but bounded so a
/// document with thousands of unmappable characters doesn't dump them all
/// into a dialog).
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

fn format_sample(ch: char) -> String {
    format!("{ch} (U+{:04X})", ch as u32)
}

/// Core, Tauri-free implementation (unit-testable without the command
/// harness — see the `tests` module below). `label` unknown -> `Err`,
/// matching `encoding::encode`'s own contract.
pub fn check_representability(text: &str, label: &str) -> Result<RepresentabilityReport, String> {
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {label}"))?;

    // Every Unicode scalar value round-trips through UTF-8 and UTF-16 by
    // construction: UTF-8 can encode any scalar value, and UTF-16 can too
    // (as a BMP code unit or a surrogate pair) -- the only code points
    // UTF-16 cannot represent are lone surrogates, which Rust's `char`
    // (and therefore `str::chars()` below) can never produce in the first
    // place. Skipping the per-character scan for these targets is a
    // correctness-preserving fast path, not just an optimization -- it
    // also means a UTF-8/UTF-16 document's Normalize flow never pays this
    // function's O(n) cost at all. The frontend applies the same
    // short-circuit before ever calling the IPC command at all (see
    // main.ts's `runNormalizeFlow` / `isUnicodeEncoding`), but this
    // function agrees independently in case it is ever exercised directly.
    if encoding == UTF_8 || encoding == UTF_16LE || encoding == UTF_16BE {
        return Ok(RepresentabilityReport {
            unmappable_count: 0,
            samples: Vec::new(),
            samples_truncated: false,
        });
    }

    let mut unmappable_count = 0usize;
    // Distinct characters already sampled, in first-encountered order. A
    // plain Vec + linear `contains` beats a HashSet here: it caps at
    // SAMPLE_CAP (20) entries, keeps insertion order for free, and the
    // linear scan only runs for characters already known unmappable.
    let mut sampled: Vec<char> = Vec::new();
    let mut samples_truncated = false;
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        let s: &str = ch.encode_utf8(&mut buf);
        let (_, _, had_unmappable) = encoding.encode(s);
        if had_unmappable {
            unmappable_count += 1;
            if !sampled.contains(&ch) {
                if sampled.len() < SAMPLE_CAP {
                    sampled.push(ch);
                } else {
                    samples_truncated = true;
                }
            }
        }
    }
    Ok(RepresentabilityReport {
        unmappable_count,
        samples: sampled.into_iter().map(format_sample).collect(),
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
}
