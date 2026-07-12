//! Side-by-side encoding preview: the same bytes decoded under two
//! candidate encodings, read-only, for manual disambiguation when
//! automatic detection can't confidently choose between look-alike legacy
//! encodings (e.g. Big5 vs GBK). Entry point: the status-bar encoding
//! menu's "Compare encodings…" item (see main.ts's showEncodingMenu /
//! src/comparepreview.ts). Never writes to disk, and -- like every
//! encoding command in this app -- raw bytes never cross IPC
//! (ARCHITECTURE.md hard constraint): only the decoded `String`s and a
//! `malformed` flag per side ever leave this module.

use crate::encoding;
use serde::Serialize;
use std::io::Read;

/// Bounded read cap, matching the `explain_detection` diagnostics sample
/// (issue #59): large enough to give both candidate decodes a realistic
/// sample, small enough to never require reading a whole large file just to
/// compare two encodings. Enforced on the disk read itself via `Read::take`
/// below, never by reading the whole file and slicing afterward -- so
/// comparing two encodings on a multi-GB file still only costs
/// `O(SAMPLE_BYTES)` I/O.
pub const SAMPLE_BYTES: usize = 64 * 1024;

/// `EncodingPreviewSide::content` is truncated to at most this many
/// characters -- char-boundary safe by construction, since it is built by
/// taking from a `chars()` iterator rather than slicing raw bytes.
const PREVIEW_CHARS: usize = 4000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingPreviewSide {
    /// Canonical encoding name actually used to decode, e.g. "Big5".
    pub encoding: String,
    /// Decoded text, truncated to at most `PREVIEW_CHARS` characters.
    pub content: String,
    pub malformed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoEncodingPreview {
    pub a: EncodingPreviewSide,
    pub b: EncodingPreviewSide,
    /// How many bytes were actually read from disk (at most `SAMPLE_BYTES`).
    pub sampled_bytes: usize,
    /// Full size of the file on disk.
    pub total_size: u64,
}

/// First `max_chars` Unicode scalar values of `s` -- trivially char-boundary
/// safe since it walks `chars()` rather than slicing bytes. Mirrors
/// `mojibake.rs`'s private helper of the same shape; kept as a small local
/// copy rather than shared, matching this codebase's existing per-module
/// convention (see also `hexdump.rs`, `batch.rs`).
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Decode `bytes` with `label` and truncate the result for display.
fn decode_side(bytes: &[u8], label: &str) -> Result<EncodingPreviewSide, String> {
    let decoded = encoding::decode_with(bytes, label)?;
    Ok(EncodingPreviewSide {
        encoding: decoded.encoding,
        content: truncate_chars(&decoded.content, PREVIEW_CHARS),
        malformed: decoded.malformed,
    })
}

/// When `label` names UTF-16LE/BE, an odd-length `sample` has a dangling
/// half code unit at the very end -- decoding it reports a spurious
/// `malformed` (an incomplete trailing code unit) that has nothing to do
/// with the file's real content, only with where the bounded read happened
/// to stop. This mirrors `lib.rs::preview_slice`'s even-alignment fix for
/// issue #61, scaled down to this command's simpler needs: the large-file
/// preview additionally hunts for a newline/surrogate-safe cut point
/// because it *keeps* what it cuts as the visible document, but this
/// command only ever shows a short, clearly-labeled disambiguation sample,
/// so a plain even-length clip is enough. A non-UTF-16 `label` (resolved
/// the same way `encoding::utf16_variant` resolves it for the large-file
/// preview path -- an explicit label, never a BOM sniff here) or an
/// already-even sample is returned unchanged.
fn align_for_label<'a>(sample: &'a [u8], label: &str) -> &'a [u8] {
    match encoding::utf16_variant(sample, Some(label)) {
        Some(_) if sample.len() % 2 == 1 => &sample[..sample.len() - 1],
        _ => sample,
    }
}

/// Read a bounded prefix of `path` (at most `SAMPLE_BYTES`) and decode it
/// under both `encoding_a` and `encoding_b`, for manual side-by-side
/// disambiguation when detection can't confidently pick between two
/// look-alike candidates (e.g. Big5 vs GBK). Read-only diagnostics: never
/// writes anything, and -- like `explain_detection` -- the bound is
/// enforced on the disk read itself via `Read::take`, so comparing two
/// encodings on a multi-GB file still only costs `O(SAMPLE_BYTES)` I/O
/// (issue #59).
///
/// Each label is resolved and decoded independently via
/// `encoding::decode_with`, which rejects an unknown label with `Err`
/// before either side is reported back -- there is no partial result. See
/// `align_for_label` for the UTF-16 sample-alignment handling (issue #61).
#[tauri::command]
pub fn preview_two_encodings(
    path: String,
    encoding_a: String,
    encoding_b: String,
) -> Result<TwoEncodingPreview, String> {
    let total_size = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mut sample = Vec::with_capacity(SAMPLE_BYTES);
    file.take(SAMPLE_BYTES as u64)
        .read_to_end(&mut sample)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let sampled_bytes = sample.len();

    let a = decode_side(align_for_label(&sample, &encoding_a), &encoding_a)?;
    let b = decode_side(align_for_label(&sample, &encoding_b), &encoding_b)?;

    Ok(TwoEncodingPreview {
        a,
        b,
        sampled_bytes,
        total_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(dir_name: &str, file_name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(file_name);
        std::fs::write(&file, bytes).unwrap();
        file
    }

    /// Core happy path: Big5-encoded Chinese text read as (Big5, UTF-8)
    /// must decode cleanly on the Big5 side and report malformed on the
    /// UTF-8 side -- Big5's lead/trail byte pairs for real CJK text are
    /// essentially never simultaneously valid UTF-8 (the same property
    /// `encoding.rs`'s `detects_big5_from_realistic_sample` test relies on:
    /// if this fixture's Big5 bytes were coincidentally valid UTF-8, that
    /// test's own detection would land on UTF-8, not Big5).
    #[test]
    fn preview_two_encodings_decodes_both_sides() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert!(
            std::str::from_utf8(&bytes).is_err(),
            "fixture must not coincidentally be valid UTF-8"
        );
        let file = write_temp("plume-compare-both-sides", "sample.txt", &bytes);

        let result = preview_two_encodings(
            file.to_string_lossy().into_owned(),
            "Big5".to_string(),
            "UTF-8".to_string(),
        )
        .unwrap();

        assert_eq!(result.a.encoding, "Big5");
        assert_eq!(result.a.content, text);
        assert!(!result.a.malformed);

        assert_eq!(result.b.encoding, "UTF-8");
        assert!(
            result.b.malformed,
            "Big5 bytes decoded as UTF-8 must be malformed"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #59-style bound: a file over `SAMPLE_BYTES` must only ever
    /// have `SAMPLE_BYTES` read from disk, regardless of its real size.
    #[test]
    fn preview_two_encodings_bounded_read() {
        let data: String = (0..20_000u32).map(|i| format!("line {i}\n")).collect();
        assert!(data.len() as u64 > SAMPLE_BYTES as u64);
        let file = write_temp("plume-compare-bounded-read", "big.txt", data.as_bytes());

        let result = preview_two_encodings(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "windows-1252".to_string(),
        )
        .unwrap();

        assert_eq!(result.sampled_bytes, SAMPLE_BYTES);
        assert_eq!(result.total_size, data.len() as u64);

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #61-style regression, scaled to this command's bounded
    /// sample: a UTF-16LE (no BOM) file whose available sample ends up an
    /// odd number of bytes must not report a spurious `malformed` from the
    /// dangling half code unit at the tail -- the alignment fix must trim
    /// it before decoding, mirroring `lib.rs::preview_slice`'s
    /// even-alignment fix for the large-file preview window.
    #[test]
    fn preview_two_encodings_utf16_even_alignment() {
        let (mut bytes, unmappable) = encoding::encode("hello", "UTF-16LE", false).unwrap();
        assert!(!unmappable);
        assert_eq!(bytes.len(), 10, "5 ASCII chars * 2 bytes, no BOM");
        bytes.push(0x41); // stray trailing byte -> odd-length sample
        let file = write_temp("plume-compare-utf16-odd", "odd.bin", &bytes);

        let result = preview_two_encodings(
            file.to_string_lossy().into_owned(),
            "UTF-16LE".to_string(),
            "UTF-8".to_string(),
        )
        .unwrap();

        assert_eq!(
            result.sampled_bytes, 11,
            "the odd stray byte is still reported as read"
        );
        assert_eq!(result.a.encoding, "UTF-16LE");
        assert_eq!(result.a.content, "hello");
        assert!(
            !result.a.malformed,
            "the dangling trailing byte must be trimmed before decoding, \
             not decoded into a malformed code unit"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn preview_two_encodings_rejects_unknown_label() {
        let file = write_temp("plume-compare-unknown-label", "sample.txt", b"hello world");

        let result = preview_two_encodings(
            file.to_string_lossy().into_owned(),
            "not-an-encoding".to_string(),
            "UTF-8".to_string(),
        );
        assert!(result.is_err());

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }
}
