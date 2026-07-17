//! Backing data for the read-only Document Info dialog (File menu;
//! ROADMAP.md v0.6 E1) — a "file trust surface" that gathers facts the app
//! already knows or can cheaply re-derive about the active document into
//! one place: on-disk size/mtime here, plus line-ending distribution here
//! too; encoding + detection evidence reuses `explain_detection` as-is
//! (lib.rs); line/word/char counts reuse the frontend's own `textStatsOf`
//! and never cross IPC at all.
//!
//! Every field this module returns is a *fresh* read off disk, never a
//! frontend-cached value — the same "always re-verify" precedent
//! `explain_detection` itself already set. The dialog takes one snapshot
//! when it opens and does not live-refresh if the file changes underneath
//! it; closing and reopening it re-snapshots (issue #201's sibling
//! commands make the identical trade-off).

use serde::Serialize;

use crate::linebreak::{reject_utf16, scan_line_breaks, LineBreakKind};
use crate::streamcodec::{read_chunk, CHUNK_BYTES};
use crate::LARGE_FILE_THRESHOLD;

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub size: u64,
    /// Milliseconds since the Unix epoch; negative for a file with a
    /// pre-epoch mtime (e.g. one created via `touch -t 196001010000`) —
    /// computed by hand rather than deriving from `SystemTime`'s own serde
    /// impl, which rejects any pre-epoch instant outright. See
    /// `fsguard.rs`'s `EpochOffset` doc comment for the identical problem
    /// solved there for `Fingerprint` (judgment-overlay.md §4); this
    /// module solves it independently with a plain signed millisecond
    /// count instead of reusing `EpochOffset`'s own shape, since — unlike
    /// a fingerprint, which is round-tripped opaquely — this value is
    /// meant to be displayed, so the frontend needs a plain number it can
    /// feed straight into `Date`.
    pub modified_ms: i64,
}

/// Fresh on-disk size and modification time for `path` (Document Info's
/// "Size" and "Modified" rows). Encoding-agnostic — unlike
/// `line_ending_distribution` below, there is no raw-byte scanning here at
/// all, so no UTF-16 exclusion applies.
#[tauri::command]
pub fn document_metadata(path: String) -> Result<DocumentMetadata, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let modified = meta
        .modified()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let modified_ms = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    };
    Ok(DocumentMetadata {
        size: meta.len(),
        modified_ms,
    })
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineEndingDistribution {
    pub lf: u64,
    pub crlf: u64,
    pub cr: u64,
    /// How many bytes were actually scanned — equal to `total_size` unless
    /// the file exceeds `LARGE_FILE_THRESHOLD`, in which case only the
    /// first `LARGE_FILE_THRESHOLD` bytes were scanned. The frontend must
    /// show an explicit "sampled" disclosure whenever this is less than
    /// `total_size` — never silently label a partial count as if it were
    /// exhaustive (ROADMAP.md v0.6 E1's own bounded-scan requirement).
    pub scanned_bytes: u64,
    pub total_size: u64,
}

/// Stream `path`'s raw bytes — bounded at `LARGE_FILE_THRESHOLD` (exact for
/// anything at or under that size, a leading sample beyond it, always
/// disclosed via `scanned_bytes < total_size`) — and tally how many of each
/// of the three line-terminator styles `linebreak.rs` recognizes it
/// contains.
///
/// Reuses `scan_line_breaks` directly, the same scanner `lineindex.rs`'s
/// `build_line_index` streams the whole file through for its own, different
/// purpose (a checkpoint index) — rather than a second,
/// independently-drifting byte-level line scanner. `pending_cr` carries
/// across `read_chunk` calls exactly as it does there, so a CRLF pair split
/// across an 8 MiB read boundary is still counted as exactly one CRLF,
/// never a lone CR plus a lone LF.
///
/// Byte-level scanning without decoding is unsound for UTF-16 (see
/// `linebreak.rs`'s module doc comment) — rejected up front via the shared
/// `reject_utf16` guard, mirroring `build_line_index`'s own exclusion.
/// ISO-2022-JP needs no such exclusion here: unlike `chunk.rs`'s paging
/// (which decodes each page and can lose JIS shift-state across a cut),
/// this never decodes anything, and ISO-2022-JP's JIS-mode byte pairs
/// always fall in 0x21-0x7E — never 0x0A/0x0D — so a literal LF/CR byte is
/// always a real terminator there too.
#[tauri::command]
pub fn line_ending_distribution(
    path: String,
    encoding: String,
) -> Result<LineEndingDistribution, String> {
    reject_utf16(&encoding, "Line-ending distribution")?;

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    // Known upfront from a single fresh metadata read, not inferred from
    // read-loop short-reads — see the post-loop pending_cr resolution
    // below for why that distinction matters at the exact boundary.
    let is_full_scan = total_size <= LARGE_FILE_THRESHOLD;
    let bound = total_size.min(LARGE_FILE_THRESHOLD);

    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut offset: u64 = 0;
    let mut pending_cr = false;
    let mut lf: u64 = 0;
    let mut crlf: u64 = 0;
    let mut cr: u64 = 0;
    while offset < bound {
        let want = std::cmp::min(buf.len() as u64, bound - offset) as usize;
        let n = read_chunk(&mut file, &mut buf[..want])
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        scan_line_breaks(
            &buf[..n],
            offset,
            &mut pending_cr,
            |_pos, kind| match kind {
                LineBreakKind::Lf => lf += 1,
                LineBreakKind::CrLf => crlf += 1,
                LineBreakKind::Cr => cr += 1,
            },
        );
        offset += n as u64;
        if n < want {
            break; // short read == real EOF
        }
    }
    if pending_cr && is_full_scan {
        // The very last byte of the (whole) file was an unresolved CR: a
        // lone-CR terminator right at EOF, matching
        // `lineindex.rs::build_line_index`'s identical resolution. Left
        // unresolved when the scan was cut short by `bound` instead (a
        // large file) — that CR might yet turn out to be the first half of
        // a CRLF whose LF sits just past the sampled window, so counting
        // it now could misclassify it; the sampled window is already
        // disclosed as inexact (`scanned_bytes < total_size`), so this one
        // uncounted terminator at the very edge of the sample is an
        // accepted, documented trade-off rather than a correctness bug —
        // see `trailing_cr_exactly_at_the_bounded_cutoff_is_not_counted`.
        cr += 1;
    }

    Ok(LineEndingDistribution {
        lf,
        crlf,
        cr,
        scanned_bytes: offset,
        total_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(name: &str, content: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("plume-docinfo-{name}-{}", std::process::id()));
        std::fs::write(&path, content).unwrap();
        path
    }

    // --- document_metadata --------------------------------------------

    #[test]
    fn returns_size_and_a_known_modified_time() {
        let content = b"hello world";
        let path = write_temp("metadata-known-mtime.txt", content);
        let target = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(target)
            .unwrap();

        let report = document_metadata(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(report.size, content.len() as u64);
        assert_eq!(report.modified_ms, 1_700_000_000_000);
        std::fs::remove_file(&path).ok();
    }

    /// Judgment-overlay.md §4's `EpochOffset` lesson exists precisely
    /// because naive `SystemTime` handling breaks for a pre-epoch mtime —
    /// this pins that `document_metadata`'s own hand-rolled conversion
    /// (deliberately not reusing `EpochOffset` itself, see the struct doc
    /// comment) gets the sign right instead of panicking or silently
    /// clamping to the epoch.
    #[test]
    fn pre_epoch_modified_time_is_negative() {
        let path = write_temp("metadata-pre-epoch.txt", b"x");
        let target = std::time::UNIX_EPOCH - std::time::Duration::from_secs(3600);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(target)
            .unwrap();

        let report = document_metadata(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(report.modified_ms, -3_600_000);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn document_metadata_errors_on_a_missing_file() {
        let result = document_metadata("/plume-docinfo-does-not-exist/nope.txt".into());
        assert!(result.is_err());
    }

    // --- line_ending_distribution ---------------------------------------

    #[test]
    fn lf_only_counts_correctly() {
        let content = b"a\nb\nc\n";
        let path = write_temp("lf-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 3);
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(report.scanned_bytes, content.len() as u64);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn crlf_only_counts_correctly_and_not_double() {
        let content = b"a\r\nb\r\nc\r\n";
        let path = write_temp("crlf-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(
            report.crlf, 3,
            "each CRLF pair must count once, not as a CR and an LF"
        );
        assert_eq!(report.cr, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lone_cr_only_counts_correctly() {
        let content = b"a\rb\rc\r";
        let path = write_temp("lone-cr-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(report.crlf, 0);
        assert_eq!(
            report.cr, 3,
            "trailing lone CR at true EOF must still be counted"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mixed_line_endings_counts_each_style_independently() {
        let content = b"a\nb\r\nc\rd\n";
        let path = write_temp("mixed.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 2);
        assert_eq!(report.crlf, 1);
        assert_eq!(report.cr, 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_file_has_zero_counts() {
        let path = write_temp("empty.txt", b"");
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, 0);
        assert_eq!(report.scanned_bytes, 0);
        std::fs::remove_file(&path).ok();
    }

    /// A CRLF pair split exactly across the 8 MiB `read_chunk` boundary
    /// (CR the very last byte of the first read, LF the very first byte of
    /// the second) must still count as exactly one CRLF — the classic
    /// streaming-scanner pitfall `pending_cr` exists to avoid, pinned here
    /// against the real chunked read loop rather than a direct
    /// `scan_line_breaks` unit call (linebreak.rs's own tests already cover
    /// that in isolation; this proves the plumbing in this module's loop
    /// carries `pending_cr` across `read_chunk` calls correctly too).
    #[test]
    fn crlf_split_across_the_8mib_chunk_boundary_counts_as_one() {
        let mut content = vec![b'a'; CHUNK_BYTES];
        content[CHUNK_BYTES - 1] = b'\r'; // last byte of the first read
        content.push(b'\n'); // first byte of the second read -> completes CRLF
        content.extend_from_slice(b"more content after\n");
        assert!(
            (content.len() as u64) < LARGE_FILE_THRESHOLD,
            "fixture must stay under the bounded-scan threshold so this is an exact, full scan"
        );
        let path = write_temp("crlf-chunk-boundary.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 1, "the trailing \"more content after\\n\"");
        assert_eq!(
            report.crlf, 1,
            "must not be double-counted as a lone CR plus a lone LF"
        );
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(report.scanned_bytes, content.len() as u64);
        std::fs::remove_file(&path).ok();
    }

    /// A file over `LARGE_FILE_THRESHOLD` is scanned only up to that bound
    /// — a terminator placed just past it must never be counted, and the
    /// report must disclose exactly how much was actually scanned.
    #[test]
    fn bounded_scan_stops_at_large_file_threshold() {
        let threshold = LARGE_FILE_THRESHOLD as usize;
        let mut content = vec![b'a'; threshold + 1024];
        content[100] = b'\n'; // one LF well within the scanned bound
                              // Terminators placed strictly after the bound must be invisible to
                              // this scan.
        content[threshold] = b'\n';
        content[threshold + 1] = b'\n';
        let path = write_temp("bounded-large.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(
            report.scanned_bytes, LARGE_FILE_THRESHOLD,
            "scan must be bounded at exactly LARGE_FILE_THRESHOLD, not the whole file"
        );
        assert_eq!(report.lf, 1, "only the LF within the scanned bound counts");
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        std::fs::remove_file(&path).ok();
    }

    /// An unresolved trailing CR landing *exactly* at the bounded cutoff is
    /// ambiguous — it might be the first half of a CRLF whose LF sits just
    /// past the sampled window — so it must be left uncounted rather than
    /// guessed as a lone CR, unlike the same situation at genuine EOF
    /// (`lone_cr_only_counts_correctly` above, where it is always safe to
    /// resolve).
    #[test]
    fn trailing_cr_exactly_at_the_bounded_cutoff_is_not_counted() {
        let threshold = LARGE_FILE_THRESHOLD as usize;
        let mut content = vec![b'a'; threshold]; // byte at index threshold-1 will be overwritten below
        content[threshold - 1] = b'\r'; // the scan's very last byte is an unresolved CR
        content.push(b'\n'); // just past the bound: would complete a CRLF, but must not be read
        content.extend_from_slice(b"tail\n");
        assert!(
            (content.len()) > threshold,
            "fixture must exceed the threshold"
        );
        let path = write_temp("bounded-trailing-cr.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.scanned_bytes, LARGE_FILE_THRESHOLD);
        assert_eq!(
            report.cr, 0,
            "the ambiguous trailing CR at the exact cutoff must not be guessed as a lone CR"
        );
        assert_eq!(
            report.crlf, 0,
            "the LF completing it sits past the scanned bound"
        );
        assert_eq!(report.lf, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16() {
        let result = line_ending_distribution("/tmp/whatever.txt".into(), "UTF-16LE".into());
        assert!(result.is_err());
        let result = line_ending_distribution("/tmp/whatever.txt".into(), "UTF-16BE".into());
        assert!(result.is_err());
    }

    #[test]
    fn line_ending_distribution_errors_on_a_missing_file() {
        let result = line_ending_distribution(
            "/plume-docinfo-does-not-exist/nope.txt".into(),
            "UTF-8".into(),
        );
        assert!(result.is_err());
    }
}
