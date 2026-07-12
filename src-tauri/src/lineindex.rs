//! Line-offset index for huge files: fast go-to-line and bookmarks beyond
//! the loaded chunk window (ARCHITECTURE.md's large-file mode, Track B,
//! ROADMAP.md). `chunk.rs` only knows how to page forward/backward from an
//! already-loaded offset — jumping straight to line 1,234,567 of a
//! multi-gigabyte file would otherwise mean paging through every chunk in
//! between. This module instead builds a sparse index of checkpoint byte
//! offsets (one every `CHECKPOINT_INTERVAL` lines) by streaming the whole
//! file once, and resolves an arbitrary target line by scanning from the
//! nearest checkpoint — at most `CHECKPOINT_INTERVAL` lines of bytes per
//! call.
//!
//! Units discipline (large-file offset danger domain, see
//! `.claude/judgment-overlay.md`): every offset in this module is a raw
//! file *byte* offset, never a character or CodeMirror position. Line
//! numbers are always 0-based here, matching `checkpoints[k]` = the byte
//! offset of line `k * CHECKPOINT_INTERVAL` (0-based). The frontend owns
//! the 0-based <-> 1-based conversion at the UI boundary (see
//! `src/lineindex.ts`); nothing 1-based ever crosses this IPC boundary.
//!
//! Like `chunk.rs`, this counts raw `0x0A` bytes rather than decoding
//! anything, which is only sound for ASCII-compatible encodings — a literal
//! 0x0A byte can never appear as part of a multi-byte sequence in any
//! encoding this app supports (UTF-8 continuation bytes are 0x80-0xBF;
//! Big5/Shift_JIS/GB18030/EUC-* lead bytes are all >= 0x80 too), so
//! byte-level newline scanning is safe without decoding first. UTF-16 is
//! the one exception (0x0A can appear as half of an unrelated code unit)
//! and is rejected up front in `build_line_index`, mirroring `chunk.rs`'s
//! paging exclusion and `streamreplace.rs`'s streaming-encode exclusion.
//! `locate_line_offset` takes no encoding parameter at all: it only ever
//! runs from a checkpoint an already-built (and therefore already
//! UTF-16-checked) index produced.
//!
//! `total_lines` counts every line implied by the byte stream: one for each
//! `0x0A` byte, plus one more if the file has trailing bytes after the last
//! `0x0A` (or contains no `0x0A` at all). A file that ends exactly on a
//! newline does *not* get a phantom empty trailing line counted — there is
//! nothing there to jump to, and no checkpoint is ever recorded pointing
//! past end of file.

use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

/// Streaming read granularity, matching `streamreplace.rs`'s rationale:
/// large enough to amortize per-read overhead on multi-GB files, small
/// enough to keep memory flat regardless of file size.
const CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Checkpoints are recorded every this many lines.
pub const CHECKPOINT_INTERVAL: u64 = 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineIndexReport {
    /// `checkpoints[k]` is the byte offset of the first byte of line
    /// `k * CHECKPOINT_INTERVAL` (0-based). `checkpoints[0]` is always 0
    /// when the file is non-empty; empty only for a 0-byte file (nothing to
    /// index). ~20k checkpoints x 8 bytes for a gigabyte-class file — small
    /// enough to cross IPC as plain metadata, never raw file bytes.
    pub checkpoints: Vec<u64>,
    pub total_lines: u64,
    /// File size at the moment the index was built, so the frontend can
    /// detect a stale index (the file changed size since) and rebuild.
    pub indexed_size: u64,
}

/// Fill `buf` as full as possible from `file`, short-reading only at EOF.
/// Mirrors `chunk.rs`'s private `read_up_to` / `streamreplace.rs`'s
/// `read_chunk`; duplicated rather than shared for the same reason
/// `streamreplace.rs` gives for its own copy — neither helper is
/// `pub(crate)`, and the duplication is a handful of lines.
fn read_chunk(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let n = file.read(&mut buf[total..])?;
        if n == 0 || total + n == buf.len() {
            return Ok(total + n);
        }
        total += n;
    }
}

fn reject_utf16(encoding: &str) -> Result<(), String> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Err("Line index is not supported for UTF-16 files".into());
    }
    Ok(())
}

/// Stream the whole file once, counting lines and recording a checkpoint
/// byte offset every `CHECKPOINT_INTERVAL` lines. `encoding` is the
/// document's already-detected encoding (the frontend passes `doc.encoding`
/// ) — used only to reject UTF-16 up front; the scan itself never decodes.
#[tauri::command]
pub fn build_line_index(path: String, encoding: String) -> Result<LineIndexReport, String> {
    reject_utf16(&encoding)?;

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let indexed_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();

    let mut checkpoints = Vec::new();
    if indexed_size > 0 {
        checkpoints.push(0);
    }

    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut offset: u64 = 0;
    let mut total_lines: u64 = 0;
    let mut ends_with_newline = false;
    loop {
        let n =
            read_chunk(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b != b'\n' {
                ends_with_newline = false;
                continue;
            }
            ends_with_newline = true;
            total_lines += 1;
            let next_line_start = offset + i as u64 + 1;
            if total_lines.is_multiple_of(CHECKPOINT_INTERVAL) && next_line_start < indexed_size {
                checkpoints.push(next_line_start);
            }
        }
        offset += n as u64;
        if n < buf.len() {
            break; // short read == EOF, matches read_chunk's contract
        }
    }
    if indexed_size > 0 && !ends_with_newline {
        // Trailing content with no final newline is still a line.
        total_lines += 1;
    }

    Ok(LineIndexReport {
        checkpoints,
        total_lines,
        indexed_size,
    })
}

/// Resolve the byte offset of `target_line`'s first byte by streaming from
/// `from_offset` (the caller-guaranteed byte offset of `from_line`'s first
/// byte — normally a `build_line_index` checkpoint). Both line numbers are
/// 0-based, matching `LineIndexReport::checkpoints`. `target_line <
/// from_line` is rejected: the caller is expected to pick a checkpoint at
/// or before the target, never after. Scanning past EOF without reaching
/// `target_line` clamps to the last line's start instead of erroring —
/// asking to go to line 50,000,000 of a 10,000-line file is a normal user
/// typo, not a failure worth interrupting them over.
#[tauri::command]
pub fn locate_line_offset(
    path: String,
    target_line: u64,
    from_offset: u64,
    from_line: u64,
) -> Result<u64, String> {
    if target_line < from_line {
        return Err(format!(
            "target_line {target_line} precedes from_line {from_line}; \
             the caller must pick a checkpoint at or before the target"
        ));
    }
    if target_line == from_line {
        return Ok(from_offset);
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    file.seek(SeekFrom::Start(from_offset))
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    let mut current_line = from_line;
    let mut offset = from_offset;
    // `from_offset` is guaranteed by the caller to be a real line start, so
    // it is always a valid clamp target even if nothing more is found.
    let mut last_line_start = from_offset;
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let n =
            read_chunk(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b != b'\n' {
                continue;
            }
            current_line += 1;
            let line_start = offset + i as u64 + 1;
            if line_start >= total_size {
                // Nothing actually starts here (EOF right after this
                // newline) — matches build_line_index's own checkpoint
                // guard, so this can never be a real target.
                continue;
            }
            last_line_start = line_start;
            if current_line == target_line {
                return Ok(line_start);
            }
        }
        offset += n as u64;
        if n < buf.len() {
            break;
        }
    }
    // EOF (or a target beyond the last line) without a match: clamp.
    Ok(last_line_start)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 13 bytes/line ("line-" + 7 digits + "\n") so offsets are k * 13 and
    /// hand-computable.
    fn fixed_width_lines(count: u64) -> String {
        let mut s = String::with_capacity((count * 13) as usize);
        for i in 0..count {
            s.push_str(&format!("line-{i:07}\n"));
        }
        s
    }

    /// 14 bytes/line ("line-" + 7 digits + "\r\n").
    fn fixed_width_crlf_lines(count: u64) -> String {
        let mut s = String::with_capacity((count * 14) as usize);
        for i in 0..count {
            s.push_str(&format!("line-{i:07}\r\n"));
        }
        s
    }

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn index_counts_lines_and_checkpoints_correctly() {
        let content = fixed_width_lines(5000);
        let path = write_temp("plume-lineindex-5000.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(report.total_lines, 5000);
        assert_eq!(report.indexed_size, content.len() as u64);
        assert_eq!(
            report.checkpoints,
            vec![0, 1024 * 13, 2048 * 13, 3072 * 13, 4096 * 13],
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn index_spans_multiple_chunk_reads() {
        // Just over CHUNK_BYTES (8 MiB) at 13 bytes/line, so build_line_index
        // must loop its read_chunk call at least twice — this is the case
        // that would break from an off-by-one in the running `offset`
        // counter carried across reads.
        let lines = (CHUNK_BYTES as u64 / 13) + 2000;
        let content = fixed_width_lines(lines);
        assert!(
            content.len() > CHUNK_BYTES,
            "fixture must span >1 chunk read"
        );
        let path = write_temp("plume-lineindex-multichunk.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(report.total_lines, lines);
        assert_eq!(report.indexed_size, content.len() as u64);
        let expected_last_k = (lines - 1) / CHECKPOINT_INTERVAL;
        assert_eq!(
            *report.checkpoints.last().unwrap(),
            expected_last_k * CHECKPOINT_INTERVAL * 13
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn locate_line_offset_finds_exact_line() {
        let content = fixed_width_lines(5000);
        let path = write_temp("plume-lineindex-locate.txt", &content);
        let path_str = path.to_string_lossy().into_owned();

        // target_line == from_line: returns from_offset without scanning.
        assert_eq!(locate_line_offset(path_str.clone(), 0, 0, 0).unwrap(), 0);

        // From the checkpoint at line 1024 (offset 1024*13), find line 1500.
        let offset = locate_line_offset(path_str.clone(), 1500, 1024 * 13, 1024).unwrap();
        assert_eq!(offset, 1500 * 13);
        std::fs::remove_file(&path).ok();

        // CRLF file: line starts still land right after \n (the \r stays
        // part of the previous line), so each line is 14 bytes wide here —
        // same treatment chunk.rs gives CRLF content.
        let crlf_content = fixed_width_crlf_lines(3000);
        let crlf_path = write_temp("plume-lineindex-crlf.txt", &crlf_content);
        let crlf_offset =
            locate_line_offset(crlf_path.to_string_lossy().into_owned(), 2500, 0, 0).unwrap();
        assert_eq!(crlf_offset, 2500 * 14);
        std::fs::remove_file(&crlf_path).ok();
    }

    #[test]
    fn locate_line_offset_rejects_target_before_from() {
        let result = locate_line_offset("/tmp/whatever.txt".into(), 5, 1300, 100);
        assert!(result.is_err());
    }

    #[test]
    fn locate_clamps_past_eof() {
        let content = fixed_width_lines(10);
        let path = write_temp("plume-lineindex-clamp.txt", &content);
        let path_str = path.to_string_lossy().into_owned();

        let offset = locate_line_offset(path_str, 999_999, 0, 0).unwrap();
        assert_eq!(
            offset,
            9 * 13,
            "clamps to line 9's start, the last of 0..=9"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16() {
        let result = build_line_index("/tmp/whatever.txt".into(), "UTF-16LE".into());
        assert!(result.is_err());
        let result = build_line_index("/tmp/whatever.txt".into(), "UTF-16BE".into());
        assert!(result.is_err());
    }

    #[test]
    fn empty_file_and_single_line_file() {
        let empty_path = write_temp("plume-lineindex-empty.txt", "");
        let report =
            build_line_index(empty_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 0);
        assert_eq!(report.checkpoints, Vec::<u64>::new());
        assert_eq!(report.indexed_size, 0);
        std::fs::remove_file(&empty_path).ok();

        // No trailing newline: still exactly one line.
        let single_path = write_temp("plume-lineindex-single.txt", "hello, world");
        let report =
            build_line_index(single_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 1);
        assert_eq!(report.checkpoints, vec![0]);
        std::fs::remove_file(&single_path).ok();

        // A lone newline: one (empty) line, fully terminated.
        let lone_nl_path = write_temp("plume-lineindex-lonenl.txt", "\n");
        let report =
            build_line_index(lone_nl_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 1);
        assert_eq!(report.checkpoints, vec![0]);
        std::fs::remove_file(&lone_nl_path).ok();
    }
}
