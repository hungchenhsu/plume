//! Chunked reading of large files for paged read-only viewing. Chunks are
//! aligned to line boundaries, which is only sound for ASCII-compatible
//! encodings — UTF-16 paging is rejected at the command layer.

use crate::encoding;
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

/// Bytes to skip so a mid-file chunk starts after the first newline.
/// A chunk with no newline at all is kept as-is (one enormous line).
pub fn align_start(bytes: &[u8]) -> usize {
    match bytes.iter().position(|&b| b == b'\n') {
        Some(pos) => pos + 1,
        None => 0,
    }
}

/// Cut at the last newline so the chunk does not end mid-line. A chunk
/// with no newline is kept whole.
pub fn cut_tail_at_newline(bytes: &[u8]) -> &[u8] {
    match bytes.iter().rposition(|&b| b == b'\n') {
        Some(pos) => &bytes[..=pos],
        None => bytes,
    }
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

    // Peek the byte before `offset`: if it is a newline, the chunk already
    // starts at a line boundary (always the case when chaining next_offset)
    // and nothing must be skipped. Reading the peek byte leaves the cursor
    // exactly at `offset`.
    let mut at_line_start = true;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        at_line_start = prev[0] == b'\n';
    }

    let mut buf = vec![0u8; CHUNK_BYTES];
    let n = read_up_to(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
    buf.truncate(n);

    let skip = if at_line_start { 0 } else { align_start(&buf) };
    let aligned = &buf[skip..];
    let end_is_eof = offset + n as u64 >= total_size;
    let (slice, next_offset) = if end_is_eof {
        (aligned, None)
    } else {
        let cut = cut_tail_at_newline(aligned);
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

    let mut at_line_start = true;
    if start > 0 {
        file.seek(SeekFrom::Start(start - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        at_line_start = prev[0] == b'\n';
    } else {
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
    }

    let mut buf = vec![0u8; (end - start) as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

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

    #[test]
    fn aligns_mid_file_chunks_to_lines() {
        assert_eq!(align_start(b"tail of line\nnext line"), 13);
        assert_eq!(align_start(b"no newline at all"), 0);
        assert_eq!(cut_tail_at_newline(b"a\nb\npartial"), b"a\nb\n");
        assert_eq!(cut_tail_at_newline(b"no newline"), b"no newline");
    }

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
