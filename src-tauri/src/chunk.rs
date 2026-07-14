//! Chunked reading of large files for paged read-only viewing. Chunks are
//! aligned to line boundaries — LF, CRLF, or lone CR, the shared semantics
//! defined in `linebreak.rs` (#119/#132), so alignment always agrees with
//! the line starts `lineindex.rs` computes for go-to-line and bookmarks.
//! Byte-level alignment is only sound for ASCII-compatible encodings —
//! UTF-16 paging is rejected at the command layer.
//!
//! A single line longer than `CHUNK_BYTES` (issue #118) cannot be aligned
//! to a terminator at all — the chunk that reads it finds none anywhere
//! in its buffer, so the buffer is returned as-is (a raw, unterminated
//! slice) and the next chunk continues from exactly where it left off.
//! Every offset this module ever hands out is therefore either a genuine
//! line start or one of these raw mid-line continuation points. Forward
//! reads take an `OffsetKind` so the two offset sources keep distinct
//! semantics: the module's own `next_offset` chain is continued exactly
//! (`Continuation` — forward paging has no later read that could recover
//! a skipped byte), while a goto/bookmark jump offset from the possibly
//! stale line index (`LineStart`) is defensively realigned to the next
//! real line start when it turns out not to be one. Backward reads
//! (`read_document_chunk_before`) only discard a leading fragment when a
//! non-empty remainder is guaranteed to be left after it. A raw cut can
//! also land mid-character; `encoding::trim_truncated_utf8_tail` /
//! `trim_truncated_utf8_head` fix the boundary back up for UTF-8, the
//! one paging-supported encoding where byte-level cuts can regroup into
//! multi-byte characters at arbitrary positions.

use crate::encoding;
use crate::linebreak::{align_start, cut_tail_at_line_break, is_line_start};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};

pub const CHUNK_BYTES: usize = 2 * 1024 * 1024;

/// What `read_document_chunk`'s `offset` is, declared by the caller —
/// the two offset sources need opposite alignment policies (#118).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum OffsetKind {
    /// The offset claims to be a line start but comes from a source that
    /// can be stale — the line-offset index behind go-to-line and
    /// bookmark jumps (`lineindex.rs`; a missed watcher event leaves it
    /// describing the previous file version). Verified against the
    /// neighboring bytes and defensively realigned forward to the next
    /// real line start when the claim is wrong. Safe here, unlike in a
    /// continuation chain: a goto is a fresh jump, so skipping a stale
    /// offset's partial line moves the window, it doesn't lose bytes
    /// from an assembled sequence.
    LineStart,
    /// The offset is a continuation point from this module's own
    /// `next_offset` chain (Next paging, continuous reading). Read
    /// exactly from here — mid-line when the previous chunk ended inside
    /// an overlong line — because realigning would silently skip the
    /// bytes between the offset and the next terminator (issue #118).
    Continuation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChunk {
    pub content: String,
    /// Line-aligned offset this chunk actually starts at.
    pub offset: u64,
    /// File offset where the next chunk begins; None at end of file.
    pub next_offset: Option<u64>,
    pub total_size: u64,
    pub malformed: bool,
}

fn read_up_to(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let n = file.read(&mut buf[total..])?;
        if n == 0 || total + n == buf.len() {
            return Ok(total + n);
        }
        total += n;
    }
}

#[tauri::command]
pub fn read_document_chunk(
    path: String,
    offset: u64,
    encoding: String,
    kind: OffsetKind,
) -> Result<DocumentChunk, String> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Err("Paging is not supported for UTF-16 files".into());
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();

    // Only a LineStart read peeks the byte before `offset`: together
    // with the chunk's own first byte it decides whether the claimed
    // line start really is one — see `linebreak::is_line_start` for why
    // the first byte matters (a CR directly followed by LF is a CRLF's
    // first half, not a line end). Reading the peek byte leaves the
    // cursor exactly at `offset`. A Continuation read never realigns
    // (issue #118: nothing ever revisits a byte forward paging skips),
    // so it seeks straight to `offset`.
    let mut prev_byte = None;
    if kind == OffsetKind::LineStart && offset > 0 {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        prev_byte = Some(prev[0]);
    } else {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
    }
    let mut buf = vec![0u8; CHUNK_BYTES];
    let n = read_up_to(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
    buf.truncate(n);

    let skip = match kind {
        OffsetKind::Continuation => 0,
        OffsetKind::LineStart => {
            let at_line_start = match prev_byte {
                None => true, // offset == 0
                Some(prev) => is_line_start(prev, buf.first().copied()),
            };
            if at_line_start {
                0
            } else {
                match align_start(&buf) {
                    // No line start anywhere in the window — the stale
                    // offset sits inside a line longer than CHUNK_BYTES.
                    // Fall back to a raw continuation-style read (never
                    // an empty or skipped window); the raw stale offset
                    // can split a UTF-8 character, so drop its orphaned
                    // continuation bytes. `align_start`'s nonzero result
                    // needs no such trim: it lands right after a real
                    // terminator, always a clean boundary.
                    0 if enc == encoding_rs::UTF_8 => {
                        buf.len() - encoding::trim_truncated_utf8_head(&buf).len()
                    }
                    aligned => aligned,
                }
            }
        }
    };
    let aligned = &buf[skip..];

    let end_is_eof = offset + n as u64 >= total_size;
    let (slice, next_offset) = if end_is_eof {
        // The file's own end is always a complete, valid boundary for a
        // well-formed encoding — trimming here would silently swallow a
        // genuinely malformed trailing sequence instead of reporting it.
        (aligned, None)
    } else {
        let cut = cut_tail_at_line_break(aligned);
        // `cut` ends either right after a real line terminator — always
        // a clean boundary, since a line-break byte is never part of a
        // multibyte sequence (linebreak.rs's ASCII-compatibility
        // guarantee) — or, when the whole buffer had no terminator at
        // all, at a raw CHUNK_BYTES cut that can land mid-character.
        // Trimming is a no-op in the first case and is only meaningful
        // for UTF-8 — see `trim_truncated_utf8_tail`'s doc for why a
        // blind byte-range check would misfire on other multibyte
        // encodings, which `trim_truncated_utf8_tail`'s own
        // `str::from_utf8` validation avoids.
        let cut = if enc == encoding_rs::UTF_8 {
            encoding::trim_truncated_utf8_tail(cut)
        } else {
            cut
        };
        (cut, Some(offset + (skip + cut.len()) as u64))
    };

    let decoded = encoding::decode_with(slice, &encoding)?;
    Ok(DocumentChunk {
        content: encoding::normalize_to_lf(&decoded.content),
        offset: offset + skip as u64,
        next_offset,
        total_size,
        malformed: decoded.malformed,
    })
}

/// Read the chunk that ends exactly at `end` (exclusive), for extending a
/// large-file window backward. `end` must be line-aligned, which holds for
/// every window start this app produces. The returned `offset` is the
/// line-aligned start of the chunk; `next_offset` echoes `end`.
#[tauri::command]
pub fn read_document_chunk_before(
    path: String,
    end: u64,
    encoding: String,
) -> Result<DocumentChunk, String> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Err("Paging is not supported for UTF-16 files".into());
    }
    if end == 0 {
        return Err("Already at the start of the file".into());
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let start = end.saturating_sub(CHUNK_BYTES as u64);

    let mut prev_byte = None;
    if start > 0 {
        file.seek(SeekFrom::Start(start - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        prev_byte = Some(prev[0]);
    } else {
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
    }

    let mut buf = vec![0u8; (end - start) as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    // Same neighbor-pair line-start test as `read_document_chunk`; the
    // buffer's first byte disambiguates a preceding CR (lone CR vs the
    // first half of a CRLF).
    let at_line_start = match prev_byte {
        None => true, // start == 0
        Some(prev) => is_line_start(prev, buf.first().copied()),
    };
    // Unlike forward paging, discarding a leading fragment here is
    // usually safe: a further backward read re-covers whatever this one
    // discards, since `end` becomes exactly this chunk's `offset`. The
    // one exception is issue #118's overlong-line case: a window that
    // lands entirely inside one line longer than CHUNK_BYTES has exactly
    // one terminator-like byte — that line's own closing terminator,
    // which (because `end` is always defined as immediately after it)
    // sits at the window's very last byte(s). `align_start`'s "skip past
    // the first terminator" would then consume the *entire* buffer,
    // leaving an empty, non-progressing chunk (offset == end, forever).
    // Only trust its result when a non-empty remainder is left;
    // otherwise fall back to the whole window, mirroring the forward
    // direction's raw continuation.
    let skip = if at_line_start {
        0
    } else {
        let aligned = align_start(&buf);
        if aligned < buf.len() {
            aligned
        } else {
            0
        }
    };
    // A raw (non-terminator-based) start can land mid-character; one
    // right after a genuine terminator never does (linebreak.rs's
    // ASCII-compatibility guarantee). Trimming is a no-op in the
    // terminator case and, like the forward direction's tail trim, only
    // meaningful for UTF-8. Same guard as `skip` above: never trust a
    // trim that would consume the entire window — a window of nothing
    // but orphaned continuation bytes (unreachable through the app's own
    // line-aligned `end` values today, but a future caller could drift)
    // must stay an honest U+FFFD chunk rather than collapse to an empty,
    // non-progressing one with offset == end.
    let pre_trim = &buf[skip..];
    let slice = if enc == encoding_rs::UTF_8 {
        let trimmed = encoding::trim_truncated_utf8_head(pre_trim);
        if trimmed.is_empty() && !pre_trim.is_empty() {
            pre_trim
        } else {
            trimmed
        }
    } else {
        pre_trim
    };
    let head_trimmed = pre_trim.len() - slice.len();

    let decoded = encoding::decode_with(slice, &encoding)?;
    Ok(DocumentChunk {
        content: encoding::normalize_to_lf(&decoded.content),
        offset: start + skip as u64 + head_trimmed as u64,
        next_offset: Some(end),
        total_size,
        malformed: decoded.malformed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit tests for `align_start` / `cut_tail_at_line_break` /
    // `is_line_start` (including the LF cases that used to live here) are
    // in `linebreak.rs` next to the shared definitions; this module keeps
    // the end-to-end paging tests.

    #[test]
    fn pages_through_a_large_file_losslessly() {
        let path = std::env::temp_dir().join("plume-chunk-test.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();
        assert!(original.len() > CHUNK_BYTES);

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(pages >= 2);
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16_paging() {
        let result = read_document_chunk(
            "/tmp/whatever.txt".into(),
            0,
            "UTF-16LE".into(),
            OffsetKind::Continuation,
        );
        assert!(result.is_err());
        let result = read_document_chunk_before("/tmp/whatever.txt".into(), 100, "UTF-16BE".into());
        assert!(result.is_err());
    }

    // --- Issue #132 (with #119): chunk alignment must share the line
    // semantics of `lineindex.rs`/`encoding::detect_line_ending` (#92):
    // LF, CRLF (one pair, never split), and lone CR all end a line. ----

    /// End-to-end repro of the go-to-line misalignment: `locate_line_offset`
    /// returns the correct byte offset of a line that starts right after a
    /// lone CR, but `read_document_chunk` used to see prev != b'\n', run
    /// `align_start`, and silently shift the window to the *next* LF-line —
    /// while the frontend still labeled the window with the requested line.
    #[test]
    fn goto_offset_on_lone_cr_line_start_is_not_misaligned() {
        let mut content = vec![b'a'; CHUNK_BYTES - 1];
        content.extend_from_slice(b"\rBBB\nCCC\rDDD");
        let path = std::env::temp_dir().join("plume-chunk-goto-lonecr.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let report = crate::lineindex::build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 4);
        let offset = crate::lineindex::locate_line_offset(path_str.clone(), 1, 0, 0).unwrap();
        assert_eq!(
            offset, CHUNK_BYTES as u64,
            "line 1 starts after the lone CR"
        );

        let chunk =
            read_document_chunk(path_str, offset, "UTF-8".into(), OffsetKind::LineStart).unwrap();
        assert_eq!(
            chunk.offset, offset,
            "a locate()-produced line start must not be shifted by alignment"
        );
        assert_eq!(chunk.content, "BBB\nCCC\nDDD");
        std::fs::remove_file(&path).ok();
    }

    /// Same misalignment in the backward-paging path: `end` lands on a line
    /// start whose previous byte is a lone CR; the old prev == b'\n' check
    /// aligned the whole window away into an empty chunk.
    #[test]
    fn backward_page_ending_after_lone_cr_is_not_misaligned() {
        let mut content = b"AA\r".to_vec();
        content.extend(vec![b'b'; CHUNK_BYTES - 1]);
        content.extend_from_slice(b"\nCCC");
        let path = std::env::temp_dir().join("plume-chunk-before-lonecr.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // Line starts: 0 ("AA"), 3 (the b-line), CHUNK_BYTES + 3 ("CCC").
        let end = (CHUNK_BYTES + 3) as u64;
        let chunk = read_document_chunk_before(path_str, end, "UTF-8".into()).unwrap();
        assert_eq!(chunk.offset, 3);
        assert_eq!(chunk.next_offset, Some(end));
        let expected = "b".repeat(CHUNK_BYTES - 1) + "\n";
        assert_eq!(chunk.content, expected);
        std::fs::remove_file(&path).ok();
    }

    /// CR-only (Classic Mac) file paging: every page boundary must land on
    /// a real line start — before this fix a CR-only file had no
    /// recognizable terminator at all in chunk.rs, so pages degenerated to
    /// arbitrary CHUNK_BYTES cuts mid-line.
    #[test]
    fn pages_through_cr_only_large_file_line_aligned_and_losslessly() {
        let path = std::env::temp_dir().join("plume-chunk-cr-only.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\r"));
        }
        let line_width = "line 0000000 with some padding text\r".len() as u64;
        std::fs::write(&path, &original).unwrap();
        assert!(original.len() > 2 * CHUNK_BYTES, "must take several pages");

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
            )
            .unwrap();
            assert_eq!(
                chunk.offset % line_width,
                0,
                "every page must start on a real line boundary"
            );
            if chunk.next_offset.is_some() {
                assert!(
                    chunk.content.ends_with('\n'),
                    "every non-final page must end on a complete line"
                );
            }
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(pages >= 2);
        assert_eq!(assembled, original.replace('\r', "\n"));
        std::fs::remove_file(&path).ok();
    }

    /// A CRLF pair whose CR is the last byte of one 2 MiB page read and
    /// whose LF opens the next must stay one pair: assembling all pages
    /// yields exactly one newline there, never two.
    #[test]
    fn crlf_split_at_page_read_boundary_stays_one_pair() {
        let mut content = b"x\n".to_vec();
        content.extend(vec![b'a'; CHUNK_BYTES - 3]);
        content.extend_from_slice(b"\r\nzzz\n");
        assert_eq!(content[CHUNK_BYTES - 1], b'\r');
        assert_eq!(content[CHUNK_BYTES], b'\n');
        let path = std::env::temp_dir().join("plume-chunk-crlf-page-split.txt");
        std::fs::write(&path, &content).unwrap();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        let expected = String::from_utf8(content.clone())
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(
            assembled, expected,
            "split CRLF must contribute exactly one newline"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_backward_through_a_large_file_losslessly() {
        let path = std::env::temp_dir().join("plume-chunk-back-test.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();

        let path_str = path.to_string_lossy().into_owned();
        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = original.len() as u64;
        let mut pages = 0;
        loop {
            let chunk = read_document_chunk_before(path_str.clone(), end, "UTF-8".into()).unwrap();
            assert_eq!(chunk.next_offset, Some(end));
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 100, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(pages >= 2);
        assembled_parts.reverse();
        assert_eq!(assembled_parts.concat(), original);

        let result = read_document_chunk_before(path_str, 0, "UTF-8".into());
        assert!(result.is_err(), "end=0 has nothing before it");
        std::fs::remove_file(&path).ok();
    }

    // --- Issue #118: a single line longer than CHUNK_BYTES must never
    // have bytes silently skipped while paging across it, in either
    // direction.
    //
    // Forward: the old path treated "offset doesn't look like a line
    // start" as "realign by skipping to the next terminator" — safe for
    // backward paging (a further backward read recovers whatever it
    // discards) but never safe going forward, where nothing ever
    // revisits a skipped byte. Once a chunk read finally reaches the
    // overlong line's own closing terminator, `align_start` skips past
    // it and discards the whole unterminated remainder that chunk was
    // continuing.
    //
    // Backward: `align_start`'s "skip past the first terminator" is only
    // safe when something remains *after* it. A CHUNK_BYTES backward
    // window that lands entirely inside one overlong line has exactly
    // one terminator-like byte — the line's own closing byte, which
    // (because `end` is always defined as immediately after it) sits at
    // the window's very last position. Skipping past it discards the
    // whole window, producing an empty, non-progressing chunk (offset
    // == end) forever. ---------------------------------------------

    /// 40,000 short lines, then a single ~12 MB line with no newline in
    /// it, then 100,000 more short lines. Plain ASCII — the multibyte
    /// character-boundary concern has its own dedicated fixture/test
    /// below — with enough content on both sides that the chunk which
    /// finally discovers the overlong line's closing terminator is never
    /// itself an EOF read (an EOF read returns its buffer whole with no
    /// call to `cut_tail_at_line_break`/`align_start`, which would
    /// sidestep the bug entirely instead of exercising it).
    fn overlong_line_fixture() -> String {
        let mut original = String::new();
        for i in 0..40_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        original.push_str(&"x".repeat(12_000_000));
        original.push('\n');
        for i in 40_000..140_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        original
    }

    #[test]
    fn pages_through_a_line_longer_than_chunk_bytes_losslessly() {
        let original = overlong_line_fixture();
        assert!(
            original.len() > 8 * CHUNK_BYTES,
            "fixture must span several chunks on both sides of the overlong line"
        );
        let path = std::env::temp_dir().join("plume-chunk-overlong-fwd.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(
            pages >= 5,
            "the overlong line alone must span several pages"
        );
        assert_eq!(
            assembled.len(),
            original.len(),
            "large-file paging skipped {} bytes across a single line longer \
             than CHUNK_BYTES",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_backward_through_a_line_longer_than_chunk_bytes_losslessly() {
        let original = overlong_line_fixture();
        let path = std::env::temp_dir().join("plume-chunk-overlong-back.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = original.len() as u64;
        let mut pages = 0;
        loop {
            let chunk = read_document_chunk_before(path_str.clone(), end, "UTF-8".into()).unwrap();
            assert_eq!(chunk.next_offset, Some(end));
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 100, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(
            pages >= 5,
            "the overlong line alone must span several pages"
        );
        assembled_parts.reverse();
        let assembled = assembled_parts.concat();
        assert_eq!(
            assembled.len(),
            original.len(),
            "backward paging skipped {} bytes across a single line longer \
             than CHUNK_BYTES",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    /// Minimal, fast repro of the backward-paging degenerate case: a
    /// CHUNK_BYTES-sized backward window that sits entirely inside one
    /// line longer than CHUNK_BYTES has exactly one terminator-like byte
    /// — the line's own closing `\n` — and it is always the window's
    /// very last byte (since `end` is defined as immediately after it).
    /// Treating `align_start`'s "skip past it" result at face value
    /// discards the *entire* window, producing an empty chunk whose
    /// offset equals `end` — no progress, forever.
    #[test]
    fn read_document_chunk_before_makes_progress_when_window_is_entirely_one_overlong_line() {
        let mut content = "x".repeat(CHUNK_BYTES + 1000);
        content.push('\n');
        content.push_str("tail\n");
        let path = std::env::temp_dir().join("plume-chunk-backward-degenerate.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let end = (CHUNK_BYTES + 1001) as u64; // start of "tail\n"
        let chunk = read_document_chunk_before(path_str, end, "UTF-8".into()).unwrap();
        assert_ne!(
            chunk.offset, end,
            "backward paging made no progress: the whole window was discarded"
        );
        assert!(
            !chunk.content.is_empty(),
            "a CHUNK_BYTES-sized window inside one overlong line must not \
             collapse to an empty page"
        );
        std::fs::remove_file(&path).ok();
    }

    /// Pins the exact mid-line cut semantics (issue #118): an interior page
    /// that never reaches a line terminator must still land its
    /// `next_offset` on a UTF-8 character boundary, consuming as many
    /// whole "中" (3-byte) characters as fit in CHUNK_BYTES. CHUNK_BYTES is
    /// not a multiple of 3, so this also pins the exact trim-to-boundary
    /// amount (the dangling tail bytes of a partial character).
    /// "prefix line\n" + a single line of "中" (3-byte UTF-8) repeated well
    /// past CHUNK_BYTES + "\nsuffix line\n". CHUNK_BYTES is not a multiple
    /// of 3, so a raw byte-count cut lands mid-character unless trimmed.
    fn overlong_multibyte_line_fixture() -> String {
        let overlong = "中".repeat(4_000_000); // 12,000,000 bytes
        format!("prefix line\n{overlong}\nsuffix line\n")
    }

    #[test]
    fn overlong_line_chunk_offsets_advance_by_whole_characters_mid_line() {
        let original = overlong_multibyte_line_fixture();
        let path = std::env::temp_dir().join("plume-chunk-overlong-offsets.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // Page 0 is exactly "prefix line\n"; page 1 is the first full read
        // entirely inside the "中" run (no terminator anywhere in it).
        let page0 = read_document_chunk(
            path_str.clone(),
            0,
            "UTF-8".into(),
            OffsetKind::Continuation,
        )
        .unwrap();
        assert_eq!(page0.content, "prefix line\n");
        let page1_offset = page0.next_offset.expect("more pages remain");

        let page1 = read_document_chunk(
            path_str,
            page1_offset,
            "UTF-8".into(),
            OffsetKind::Continuation,
        )
        .unwrap();
        assert!(
            !page1.malformed,
            "a chunk boundary must never manufacture a decode error out of a \
             valid file"
        );
        assert!(
            !page1.content.contains('\u{FFFD}'),
            "a raw chunk cut must never split a multibyte character"
        );
        let consumed = page1
            .next_offset
            .expect("the overlong line continues past this page")
            - page1.offset;
        assert_eq!(
            consumed,
            (CHUNK_BYTES - CHUNK_BYTES % 3) as u64,
            "an interior page must consume whole characters only, trimming \
             the {} dangling tail byte(s) of a partial character",
            CHUNK_BYTES % 3
        );
        assert_eq!(page1.content.len() as u64, consumed);
        assert!(page1.content.chars().all(|c| c == '中'));
        assert!(!page1.content.contains('\n'));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_through_a_trailing_overlong_line_with_no_terminator_losslessly() {
        // Issue #118's EOF/no-newline case: the file ends abruptly in the
        // middle of the overlong line — no terminator anywhere after the
        // prefix line, all the way to EOF. Multibyte content, so this also
        // proves the true-EOF path never needs (or wrongly applies) the
        // character-boundary trim: any corruption would show up as a
        // length mismatch below (U+FFFD is not byte-length-neutral once
        // more than one accumulates against the "中" it replaces).
        let overlong = "中".repeat(4_000_000);
        let original = format!("prefix line\n{overlong}");
        assert!(original.len() > 5 * CHUNK_BYTES);
        let path = std::env::temp_dir().join("plume-chunk-overlong-eof.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert_eq!(
            assembled.len(),
            original.len(),
            "lost {} bytes paging to EOF through an overlong final line with \
             no terminator",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    // --- #118 follow-up (critic review): goto's chunk read must keep its
    // defensive realignment. `locate_line_offset` results ride on the
    // line index, which a missed watcher event can leave stale — a stale
    // index can hand goto a mid-line, even mid-character, offset. Removing
    // forward realignment (the #118 fix) must not turn that stale offset
    // into a garbled window top; a goto read realigns to the next real
    // line start (nothing is permanently lost — goto is a fresh jump, not
    // a continuation chain), while paging reads stay raw. -----------------

    #[test]
    fn goto_read_realigns_a_stale_mid_line_offset_to_the_next_line_start() {
        let path = std::env::temp_dir().join("plume-chunk-goto-stale-midline.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();
        let line_width = "line 0000000 with some padding text\n".len() as u64;

        // A stale index claims line 1001 starts 7 bytes into line 1000.
        let stale = 1000 * line_width + 7;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            1001 * line_width,
            "a goto read from a stale mid-line offset must realign to the \
             next real line start, not render a partial line at the window top"
        );
        assert!(chunk.content.starts_with("line 0001001 "));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn goto_read_realigns_a_stale_mid_character_offset_cleanly() {
        let path = std::env::temp_dir().join("plume-chunk-goto-stale-midchar.txt");
        let line = format!("{}\n", "中".repeat(10)); // 31 bytes per line
        let original = line.repeat(200_000);
        std::fs::write(&path, &original).unwrap();
        let line_width = line.len() as u64;

        // A stale index lands one byte into the second "中" of line 500 —
        // both mid-line and mid-character.
        let stale = 500 * line_width + 4;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            501 * line_width,
            "a stale mid-character offset must realign to the next line start"
        );
        assert!(
            !chunk.content.contains('\u{FFFD}'),
            "a realigned goto window must never start mid-character"
        );
        assert!(chunk.content.starts_with("中中"));
        std::fs::remove_file(&path).ok();
    }

    /// When the stale offset sits inside a line longer than CHUNK_BYTES,
    /// there is no line start anywhere in the window to realign to. The
    /// goto read must then fall back to a raw continuation-style read —
    /// never an empty window, never a skipped window — only nudged off
    /// the mid-character position (the raw stale offset can split a
    /// multibyte character; the continuation chain's own offsets never do).
    #[test]
    fn goto_read_falls_back_to_raw_inside_an_overlong_line() {
        let original = overlong_multibyte_line_fixture();
        let path = std::env::temp_dir().join("plume-chunk-goto-stale-overlong.txt");
        std::fs::write(&path, &original).unwrap();

        // One byte into a "中" deep inside the 12 MB run: mid-character,
        // with the nearest terminator megabytes away in both directions.
        let stale = (12 + 300_000 * 3 + 1) as u64;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            stale + 2,
            "no line start in the window: fall back to a raw read, dropping \
             only the stale offset's own orphaned continuation bytes"
        );
        assert!(
            !chunk.content.is_empty(),
            "fallback must not produce an empty window"
        );
        assert!(!chunk.content.contains('\u{FFFD}'));
        assert!(chunk.content.chars().all(|c| c == '中'));
        let consumed = chunk.next_offset.unwrap() - chunk.offset;
        assert_eq!(consumed % 3, 0, "must consume whole characters");
        std::fs::remove_file(&path).ok();
    }

    /// Symmetric guard on the backward head-trim (critic follow-up): a
    /// window consisting entirely of orphaned continuation bytes must not
    /// be trimmed into an empty, non-progressing chunk (offset == end).
    /// Unreachable through the app's own line-aligned `end` values today —
    /// a line-aligned window never both starts and ends inside one
    /// character — so this pins the defensive fallback for future callers:
    /// deliberately hand in a non-line-aligned `end` inside a malformed
    /// file head and expect an honest U+FFFD window over an empty one.
    #[test]
    fn backward_head_trim_never_consumes_the_entire_window() {
        let path = std::env::temp_dir().join("plume-chunk-before-all-continuation.txt");
        std::fs::write(&path, b"\x80\x81\nrest of the file\n").unwrap();

        let chunk =
            read_document_chunk_before(path.to_string_lossy().into_owned(), 2, "UTF-8".into())
                .unwrap();
        assert!(
            !chunk.content.is_empty(),
            "an all-continuation-bytes window must fall back to the raw \
             bytes, not collapse to an empty chunk"
        );
        assert_eq!(
            chunk.offset, 0,
            "the window must keep covering its bytes (offset == end would \
             make backward paging spin in place)"
        );
        std::fs::remove_file(&path).ok();
    }
}
