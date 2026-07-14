//! Shared streaming decode/encode chunk primitives for whole-file, on-disk
//! Rust-side transforms: extracted out of `streamreplace.rs` (issue #94's
//! streaming find/replace) the same way `fsguard.rs` was extracted from it
//! for a second caller (issues #113/#114) -- once `streamconvert.rs`
//! (ROADMAP.md v0.4 Track B "Streaming encoding conversion") needed the
//! exact same buffer-growth-loop logic, forking it into a second copy would
//! have meant keeping two implementations of `CoderResult::OutputFull`
//! handling in sync by hand. Small helpers with only one extra caller
//! (`read_chunk` here included) are still cheap enough to duplicate on their
//! own terms -- see `streamreplace.rs`'s own precedent for that -- but
//! `decode_chunk`/`encode_chunk` are the actual correctness-critical
//! primitives every streaming caller's safety discipline rests on, which is
//! a materially different bar than a ten-line convenience wrapper.
//!
//! Both callers still own their own per-transform loop
//! (`streamreplace.rs::run_replace_loop`, `streamconvert.rs::run_convert_loop`):
//! only the per-chunk decode/encode/read mechanics live here, not the
//! looping/carry semantics specific to each transform.

use encoding_rs::{CoderResult, Decoder, Encoder};

/// Source-side read granularity: large enough that per-chunk overhead is
/// negligible even for multi-GB files, small enough that memory use stays
/// bounded and predictable regardless of file size. Shared by every
/// streaming whole-file transform so they all make the same memory/overhead
/// trade-off.
pub(crate) const CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Fill `buf` as full as possible from `file`, short-reading only at EOF.
/// Mirrors `chunk.rs`'s private `read_up_to`; not reused directly since that
/// helper isn't `pub(crate)` and duplicating a handful of lines here is
/// cheaper than widening its visibility for one extra caller (the same
/// judgment call `streamreplace.rs` originally made when it wrote this).
pub(crate) fn read_chunk(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut total = 0;
    loop {
        let n = file.read(&mut buf[total..])?;
        if n == 0 || total + n == buf.len() {
            return Ok(total + n);
        }
        total += n;
    }
}

/// Decode `raw` with `decoder`, growing the output buffer as needed so the
/// whole input is consumed in one logical call. `decode_to_string` only
/// fills up to the destination's *current* capacity and reports
/// `OutputFull` rather than growing it itself, so a plain single call
/// without this loop could silently leave part of `raw` unconsumed. Returns
/// the decoded text and whether any malformed byte sequence was replaced
/// with U+FFFD along the way -- every caller of this function treats that
/// as a fatal, abort-the-whole-run condition (surfacing a decode error
/// rather than silently rendering mojibake as if it were fine, matching
/// ARCHITECTURE.md's hard constraint).
pub(crate) fn decode_chunk(decoder: &mut Decoder, mut raw: &[u8], is_last: bool) -> (String, bool) {
    let mut out = String::with_capacity(
        decoder
            .max_utf8_buffer_length(raw.len())
            .unwrap_or_else(|| raw.len().saturating_mul(3) + 32),
    );
    let mut had_errors = false;
    loop {
        let (result, read, errors) = decoder.decode_to_string(raw, &mut out, is_last);
        had_errors |= errors;
        raw = &raw[read..];
        match result {
            CoderResult::InputEmpty => return (out, had_errors),
            CoderResult::OutputFull => {
                let needed = decoder
                    .max_utf8_buffer_length(raw.len())
                    .unwrap_or_else(|| raw.len().saturating_mul(3) + 32);
                out.reserve(needed);
            }
        }
    }
}

/// Encode `text` with `encoder`, growing the output buffer as needed -- the
/// encode-side mirror of `decode_chunk`, same rationale. Returns the encoded
/// bytes and whether any unmappable character was hit. Encoding_rs always
/// substitutes an HTML-style numeric character reference for an unmappable
/// character rather than failing outright, so this always returns real
/// bytes for the whole of `text` regardless of the `bool`; callers decide
/// independently whether writing those substituted bytes is acceptable
/// (`streamreplace.rs` treats any unmappable output as a should-never-happen
/// abort since it only ever re-encodes characters that already round-tripped
/// through the same encoding once; `streamconvert.rs` treats it as the
/// expected lossy-conversion case, gated behind its own `allow_lossy`).
pub(crate) fn encode_chunk(
    encoder: &mut Encoder,
    mut text: &str,
    is_last: bool,
) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(
        encoder
            .max_buffer_length_from_utf8_if_no_unmappables(text.len())
            .unwrap_or_else(|| text.len().saturating_mul(4) + 32),
    );
    let mut had_unmappable = false;
    loop {
        let (result, read, unmappable) = encoder.encode_from_utf8_to_vec(text, &mut out, is_last);
        had_unmappable |= unmappable;
        text = &text[read..];
        match result {
            CoderResult::InputEmpty => return (out, had_unmappable),
            CoderResult::OutputFull => {
                let needed = encoder
                    .max_buffer_length_from_utf8_if_no_unmappables(text.len())
                    .unwrap_or_else(|| text.len().saturating_mul(4) + 32);
                out.reserve(needed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::{BIG5, UTF_8};

    fn write_and_open(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::fs::File {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::File::open(&path).unwrap()
    }

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("plume-streamcodec-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_chunk_fills_buffer_across_short_reads() {
        let dir = fixture_dir("read-chunk-full");
        let mut file = write_and_open(&dir, "f.bin", &[1u8; 100]);
        let mut buf = [0u8; 100];
        let n = read_chunk(&mut file, &mut buf).unwrap();
        assert_eq!(n, 100);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_chunk_short_reads_at_eof() {
        let dir = fixture_dir("read-chunk-eof");
        let mut file = write_and_open(&dir, "f.bin", &[7u8; 50]);
        let mut buf = [0u8; 100];
        let n = read_chunk(&mut file, &mut buf).unwrap();
        assert_eq!(n, 50, "must short-read at EOF rather than block/error");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decode_chunk_decodes_plain_utf8() {
        let mut decoder = UTF_8.new_decoder_with_bom_removal();
        let (text, had_errors) = decode_chunk(&mut decoder, "hello world".as_bytes(), true);
        assert_eq!(text, "hello world");
        assert!(!had_errors);
    }

    #[test]
    fn decode_chunk_reports_errors_for_malformed_bytes() {
        let mut decoder = BIG5.new_decoder_with_bom_removal();
        // 0x80 is below Big5's lead-byte floor and not a valid trail byte.
        let (_, had_errors) = decode_chunk(&mut decoder, &[0x80], true);
        assert!(had_errors);
    }

    #[test]
    fn decode_chunk_across_non_final_and_final_calls_matches_whole_decode() {
        // A Big5 CJK character's 2 bytes split across two decode_chunk
        // calls (is_last: false then true) must reassemble exactly like
        // decoding both bytes in one shot -- the whole point of the
        // streaming `Decoder` this wraps.
        let (bytes, unmappable) = crate::encoding::encode("中文", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(bytes.len(), 4);
        let mut decoder = BIG5.new_decoder_with_bom_removal();
        let (first, errors1) = decode_chunk(&mut decoder, &bytes[..1], false);
        let (second, errors2) = decode_chunk(&mut decoder, &bytes[1..], true);
        assert!(!errors1 && !errors2);
        assert_eq!(format!("{first}{second}"), "中文");
    }

    #[test]
    fn encode_chunk_encodes_plain_ascii_cleanly() {
        let mut encoder = UTF_8.new_encoder();
        let (bytes, had_unmappable) = encode_chunk(&mut encoder, "hello", true);
        assert_eq!(bytes, b"hello");
        assert!(!had_unmappable);
    }

    #[test]
    fn encode_chunk_reports_unmappable_but_still_returns_bytes() {
        let mut encoder = BIG5.new_encoder();
        let (bytes, had_unmappable) = encode_chunk(&mut encoder, "🚀", true);
        assert!(had_unmappable);
        assert!(
            !bytes.is_empty(),
            "encoding_rs substitutes an NCR fallback rather than emitting nothing"
        );
    }

    #[test]
    fn encode_chunk_across_two_calls_concatenates_to_single_call_result() {
        let mut single = UTF_8.new_encoder();
        let (whole, _) = encode_chunk(&mut single, "中文測試", true);

        let mut split = UTF_8.new_encoder();
        let (first, _) = encode_chunk(&mut split, "中文", false);
        let (second, _) = encode_chunk(&mut split, "測試", true);
        let mut concatenated = first;
        concatenated.extend_from_slice(&second);

        assert_eq!(whole, concatenated);
    }
}
