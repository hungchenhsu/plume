//! Chunked reading of large files for paged read-only viewing. Chunks are
//! aligned to line boundaries — LF, CRLF, or lone CR, the shared semantics
//! defined in `linebreak.rs` (#119/#132), so alignment always agrees with
//! the line starts `lineindex.rs` computes for go-to-line and bookmarks.
//! Byte-level alignment is only sound for ASCII-compatible encodings —
//! UTF-16 paging is rejected at the command layer.

use crate::encoding;
use crate::linebreak::{align_start, cut_tail_at_line_break, is_line_start};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

pub const CHUNK_BYTES: usize = 2 * 1024 * 1024;

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

    // Peek the byte before `offset`: together with the chunk's own first
    // byte it decides whether `offset` already sits at a line boundary
    // (always the case when chaining next_offset) — see
    // `linebreak::is_line_start` for why the first byte matters (a CR
    // directly followed by LF is a CRLF's first half, not a line end).
    // Reading the peek byte leaves the cursor exactly at `offset`.
    let mut prev_byte = None;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        prev_byte = Some(prev[0]);
    }

    let mut buf = vec![0u8; CHUNK_BYTES];
    let n = read_up_to(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
    buf.truncate(n);

    let at_line_start = match prev_byte {
        None => true, // offset == 0
        Some(prev) => is_line_start(prev, buf.first().copied()),
    };
    let skip = if at_line_start { 0 } else { align_start(&buf) };
    let aligned = &buf[skip..];
    let end_is_eof = offset + n as u64 >= total_size;
    let (slice, next_offset) = if end_is_eof {
        (aligned, None)
    } else {
        let cut = cut_tail_at_line_break(aligned);
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
    let skip = if at_line_start { 0 } else { align_start(&buf) };
    let slice = &buf[skip..];

    let decoded = encoding::decode_with(slice, &encoding)?;
    Ok(DocumentChunk {
        content: encoding::normalize_to_lf(&decoded.content),
        offset: start + skip as u64,
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
            let chunk =
                read_document_chunk(path.to_string_lossy().into_owned(), at, "UTF-8".into())
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
        let result = read_document_chunk("/tmp/whatever.txt".into(), 0, "UTF-16LE".into());
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

        let chunk = read_document_chunk(path_str, offset, "UTF-8".into()).unwrap();
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
            let chunk =
                read_document_chunk(path.to_string_lossy().into_owned(), at, "UTF-8".into())
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
            let chunk =
                read_document_chunk(path.to_string_lossy().into_owned(), at, "UTF-8".into())
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
}
