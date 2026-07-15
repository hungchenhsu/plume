//! The single source of truth for line-break semantics shared by
//! large-file chunk alignment (`chunk.rs`), the line-offset index
//! (`lineindex.rs`), and folder-wide find/replace (`search.rs`,
//! `replaceinfiles.rs`), fixing #119/#132/#162. A line is terminated by
//! LF, CRLF, or a lone CR (Classic Mac line endings) — the same
//! three-way split `encoding::detect_line_ending` (#92) uses on decoded
//! text, so "where does a line start" agrees everywhere in the app. CRLF
//! always counts as *one* terminator; no helper here ever places a
//! boundary between a CR and the LF that follows it.
//!
//! Two layers of the same definition live here: [`scan_line_breaks`] and
//! its byte-offset siblings below operate on raw `&[u8]` (what
//! `replaceinfiles.rs::split_line_segments` builds on directly);
//! [`split_str_lines`] is the `&str` counterpart for callers that already
//! hold decoded text (`search.rs`) — see its own doc comment for why
//! delegating to the same byte scanner is sound rather than a second,
//! independently-drifting implementation.
//!
//! Byte-scanning without decoding is only sound for ASCII-compatible
//! encodings — a literal `0x0A` (LF) or `0x0D` (CR) byte can never appear
//! as part of a multi-byte sequence in any encoding this app supports
//! (UTF-8 continuation bytes are 0x80-0xBF; Big5/Shift_JIS/GB18030/EUC-*
//! lead and trail bytes never dip into the 0x00-0x1F control range
//! either). UTF-16 is the one exception (0x0A/0x0D can appear as half of
//! an unrelated code unit); every caller rejects UTF-16 up front at its
//! command layer before reaching these helpers.
//!
//! The recurring subtlety in every helper is the *unresolved trailing CR*:
//! a `\r` as the last byte of a buffer could be a lone CR or the first
//! half of a CRLF whose LF sits in the next read. Each helper resolves it
//! the fail-safe way for its own job — `scan_line_breaks` defers the
//! verdict via `pending_cr`, `align_start` treats it as "no complete
//! terminator found", and `cut_tail_at_line_break` cuts before it (or
//! keeps the whole buffer when it is the only candidate) so the pair can
//! reunite in the next chunk. Splitting a CRLF in half — the classic
//! streaming-scanner pitfall — is impossible by construction in all of
//! them.

/// Scan `bytes` — the file's bytes starting at absolute file offset
/// `base_offset` — for line terminators, calling `on_break(next_line_start)`
/// once per line found (`next_line_start` is the absolute byte offset where
/// the following line begins). Recognizes LF, CRLF (counted once — the
/// trailing LF is never also counted as a lone LF, mirroring
/// `encoding::detect_line_ending`'s `i += 2`), and lone CR. `bytes` must be
/// non-empty; all callers already only invoke this after checking their
/// read returned data.
///
/// `pending_cr` carries state across calls on the same stream so a CRLF
/// pair split across two chunk reads — CR the very last byte of one read,
/// LF the very first byte of the next — is still recognized as a single
/// boundary rather than double-counted as a lone CR plus a lone LF. When a
/// call ends with an unresolved trailing CR (the last byte of `bytes` was
/// `\r`), `*pending_cr` is left `true` and that CR's own boundary is *not*
/// reported yet — the next call decides whether it was lone or the start of
/// a split CRLF. If the stream truly ends with `pending_cr` still `true`
/// (the file's very last byte was `\r`), the caller must resolve it as a
/// lone-CR terminator directly; see `build_line_index`'s post-loop check in
/// `lineindex.rs`.
pub(crate) fn scan_line_breaks(
    bytes: &[u8],
    base_offset: u64,
    pending_cr: &mut bool,
    mut on_break: impl FnMut(u64),
) {
    debug_assert!(!bytes.is_empty(), "callers only scan non-empty reads");
    let mut i = 0usize;
    if *pending_cr {
        *pending_cr = false;
        if bytes[0] == b'\n' {
            // Completes a CRLF split across the chunk boundary: one
            // boundary, not two.
            on_break(base_offset + 1);
            i = 1;
        } else {
            // The previous read's trailing CR stood alone; its line ends
            // right at the start of this slice. `bytes[0]` was not
            // consumed here and is reprocessed by the loop below.
            on_break(base_offset);
        }
    }
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                on_break(base_offset + i as u64 + 2);
                i += 2;
            }
            b'\r' if i + 1 < bytes.len() => {
                // Lone CR fully resolved within this slice (next byte is
                // known and is not `\n`).
                on_break(base_offset + i as u64 + 1);
                i += 1;
            }
            b'\r' => {
                // Last byte of this slice: defer the verdict to the next
                // call (or the caller's true-EOF finalization).
                *pending_cr = true;
                i += 1;
            }
            b'\n' => {
                on_break(base_offset + i as u64 + 1);
                i += 1;
            }
            _ => i += 1,
        }
    }
}

/// Split already-decoded `text` into lines using the same LF/CRLF/lone-CR
/// definition as [`scan_line_breaks`] — unlike `str::lines()`, which only
/// recognizes LF and CRLF and so treats a whole Classic Mac (lone-CR) file
/// as a single line (issue #162). Each returned slice is one line's
/// content with its own terminator stripped, mirroring `str::lines()`'s
/// own convention (no trailing empty line for text ending on a
/// terminator; `""` yields no lines at all).
///
/// Delegates to `scan_line_breaks` on `text.as_bytes()` rather than
/// re-deriving LF/CRLF/lone-CR detection with a second, independent
/// `char`-based scan: decoded text is always UTF-8, which — like every
/// `is_ascii_compatible()` encoding this module's own doc comment already
/// reasons about — never places a literal `0x0A`/`0x0D` byte inside a
/// multi-byte sequence (`replaceinfiles.rs`'s `whole_file_replace` relies
/// on the identical fact to re-split decoded text by raw byte offsets).
/// Every offset `scan_line_breaks` reports is therefore guaranteed to land
/// on a `str` char boundary, so slicing `text` at those offsets can never
/// panic. This also means `split_str_lines` can never drift out of sync
/// with the byte-level scanner other callers use directly — there is only
/// ever one LF/CRLF/lone-CR decision, just two ways to consume it; see the
/// `split_str_lines_agrees_with_byte_level_line_table` test below for the
/// equivalence lock.
pub(crate) fn split_str_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut ends: Vec<usize> = Vec::new();
    let mut pending_cr = false;
    scan_line_breaks(bytes, 0, &mut pending_cr, |next_line_start| {
        ends.push(next_line_start as usize);
    });
    if pending_cr {
        // Unresolved trailing CR: there is no next chunk (this is the
        // whole string), so it's a lone-CR terminator right at EOF —
        // mirrors `replaceinfiles.rs::split_line_segments`'s identical
        // post-loop resolution and `lineindex.rs`'s `build_line_index`.
        ends.push(bytes.len());
    }

    let mut lines = Vec::with_capacity(ends.len() + 1);
    let mut start = 0usize;
    for end in ends {
        let line = &text[start..end];
        let content = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .or_else(|| line.strip_suffix('\r'))
            .unwrap_or(line);
        lines.push(content);
        start = end;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// Bytes to skip so a mid-file chunk starts right after its first
/// *complete* line terminator. A chunk with no complete terminator at all
/// is kept as-is (one enormous line), including the case where the only
/// candidate is an unresolved trailing `\r` — skipping on that guess could
/// land the chunk start between the halves of a split CRLF.
///
/// Agrees with `scan_line_breaks` by construction: the return value is
/// exactly the first boundary that function would report for the same
/// slice (or 0 when it would report none); `agreement` tests below lock
/// this.
pub(crate) fn align_start(bytes: &[u8]) -> usize {
    match bytes.iter().position(|&b| b == b'\n' || b == b'\r') {
        Some(pos) if bytes[pos] == b'\n' => pos + 1,
        // CRLF: one pair, skip both halves.
        Some(pos) if bytes.get(pos + 1) == Some(&b'\n') => pos + 2,
        // Lone CR, complete because its successor is known not to be LF.
        Some(pos) if pos + 1 < bytes.len() => pos + 1,
        // No terminator, or only an unresolved trailing CR.
        _ => 0,
    }
}

/// Cut at the last *complete* line terminator so the chunk does not end
/// mid-line. An unresolved trailing `\r` (possibly the first half of a
/// CRLF whose LF is in the next read) is never a cut point: when an
/// earlier complete terminator exists the cut lands there instead, pushing
/// the ambiguous CR whole into the next chunk where its successor byte is
/// visible; when it is the only candidate the whole buffer is kept (same
/// fallback as a chunk with no terminator at all — cutting before a lone
/// leading-edge CR would strand terminator bytes in no chunk at all and
/// silently drop a line break from the assembled content).
///
/// Mirrors `scan_line_breaks`'s `pending_cr` deferral; the `agreement`
/// tests below lock the cut point to that function's last reported
/// boundary.
pub(crate) fn cut_tail_at_line_break(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    loop {
        match bytes[..end].iter().rposition(|&b| b == b'\n' || b == b'\r') {
            None => return bytes,
            // LF always ends a terminator (its own, or a CRLF's second
            // half). A CR with a known successor is a complete lone CR —
            // the successor can never be LF here: on the first pass
            // rposition would have found that LF instead, and on later
            // passes the successor is either a non-terminator or the
            // trailing CR just stepped over.
            Some(pos) if bytes[pos] == b'\n' || pos + 1 < bytes.len() => return &bytes[..=pos],
            // Unresolved trailing CR: look for a complete terminator
            // before it.
            Some(pos) => end = pos,
        }
    }
}

/// Whether a file position is a line start, judged from its neighboring
/// bytes: `prev` is the byte immediately before the position, `at` the
/// byte at the position (`None` at end of file). True right after an LF
/// (which also ends a CRLF) and right after a lone CR — but a CR directly
/// followed by LF is a CRLF's first half, so the position between them is
/// *inside* a terminator, not a line start.
pub(crate) fn is_line_start(prev: u8, at: Option<u8>) -> bool {
    prev == b'\n' || (prev == b'\r' && at != Some(b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn breaks(bytes: &[u8]) -> Vec<u64> {
        let mut found = Vec::new();
        let mut pending_cr = false;
        scan_line_breaks(bytes, 0, &mut pending_cr, |b| found.push(b));
        found
    }

    #[test]
    fn align_start_handles_all_terminator_styles() {
        // Pre-existing LF behavior, unchanged.
        assert_eq!(align_start(b"tail of line\nnext line"), 13);
        assert_eq!(align_start(b"no newline at all"), 0);
        // Lone CR terminates a line.
        assert_eq!(align_start(b"tail\rnext"), 5);
        // First terminator wins even when an LF follows later.
        assert_eq!(align_start(b"a\rb\r\nc"), 2);
        // CRLF is skipped as one pair — never lands between CR and LF.
        assert_eq!(align_start(b"tail\r\nnext"), 6);
        assert_eq!(align_start(b"\r\nx"), 2);
        assert_eq!(align_start(b"\nx"), 1);
        // Unresolved trailing CR is not a complete terminator.
        assert_eq!(align_start(b"xxx\r"), 0);
        assert_eq!(align_start(b"\r"), 0);
    }

    #[test]
    fn cut_tail_handles_all_terminator_styles() {
        // Pre-existing LF behavior, unchanged.
        assert_eq!(cut_tail_at_line_break(b"a\nb\npartial"), b"a\nb\n");
        assert_eq!(cut_tail_at_line_break(b"no newline"), b"no newline");
        // Complete lone CR is a cut point.
        assert_eq!(cut_tail_at_line_break(b"a\rb"), b"a\r");
        // CRLF cuts after the pair, never between.
        assert_eq!(cut_tail_at_line_break(b"a\r\nb"), b"a\r\n");
        // Unresolved trailing CR: cut at the previous complete terminator.
        assert_eq!(cut_tail_at_line_break(b"AB\rC\r"), b"AB\r");
        assert_eq!(cut_tail_at_line_break(b"a\r\nb\r"), b"a\r\n");
        assert_eq!(cut_tail_at_line_break(b"a\r\r"), b"a\r");
        // ...or keep the whole buffer when it is the only candidate.
        assert_eq!(cut_tail_at_line_break(b"xxxx\r"), b"xxxx\r");
        assert_eq!(cut_tail_at_line_break(b"\r"), b"\r");
    }

    #[test]
    fn is_line_start_three_way() {
        // After LF: always a line start (also covers CRLF's second half).
        assert!(is_line_start(b'\n', Some(b'x')));
        assert!(is_line_start(b'\n', Some(b'\n')));
        assert!(is_line_start(b'\n', None));
        // After lone CR: a line start...
        assert!(is_line_start(b'\r', Some(b'x')));
        assert!(is_line_start(b'\r', Some(b'\r')));
        assert!(is_line_start(b'\r', None));
        // ...but between CR and LF is inside a CRLF, not a line start.
        assert!(!is_line_start(b'\r', Some(b'\n')));
        // After any other byte: mid-line.
        assert!(!is_line_start(b'x', Some(b'\n')));
        assert!(!is_line_start(b'x', None));
    }

    /// The three helpers must never drift apart: `align_start` is
    /// `scan_line_breaks`'s first reported boundary (or 0 when none) and
    /// `cut_tail_at_line_break` is its last (or the whole buffer when
    /// none) — on every terminator shape including the unresolved
    /// trailing CR.
    #[test]
    fn agreement_between_scanner_and_alignment_helpers() {
        let cases: &[&[u8]] = &[
            b"plain no terminator",
            b"a\nb\nc",
            b"a\r\nb\r\nc",
            b"a\rb\rc",
            b"mixed\rstyles\r\nhere\nend",
            b"a\rb\r\nc\nd\r",
            b"\r",
            b"\n",
            b"\r\n",
            b"\r\r",
            b"\n\r",
            b"xxx\r",
            b"xxx\r\n",
            b"\rxxx",
            b"a\r\r\nb",
        ];
        for &case in cases {
            let found = breaks(case);
            assert_eq!(
                align_start(case) as u64,
                found.first().copied().unwrap_or(0),
                "align_start disagrees with scan_line_breaks on {case:?}"
            );
            assert_eq!(
                cut_tail_at_line_break(case).len() as u64,
                found.last().copied().unwrap_or(case.len() as u64),
                "cut_tail_at_line_break disagrees with scan_line_breaks on {case:?}"
            );
        }
    }

    #[test]
    fn scan_reports_each_style_once() {
        assert_eq!(breaks(b"a\nb"), vec![2]);
        assert_eq!(breaks(b"a\r\nb"), vec![3], "CRLF is one break, not two");
        assert_eq!(breaks(b"a\rb"), vec![2]);
        assert_eq!(breaks(b"aaa\nbbb\r\nccc\rddd"), vec![4, 9, 13]);
        // Trailing CR is deferred, not reported.
        assert_eq!(breaks(b"a\r"), Vec::<u64>::new());
    }

    #[test]
    fn scan_pending_cr_resolves_across_calls() {
        // CR|LF split: one boundary at the LF.
        let mut pending = false;
        let mut found = Vec::new();
        scan_line_breaks(b"aa\r", 0, &mut pending, |b| found.push(b));
        assert!(pending);
        assert_eq!(found, Vec::<u64>::new());
        scan_line_breaks(b"\nbb", 3, &mut pending, |b| found.push(b));
        assert!(!pending);
        assert_eq!(found, vec![4], "split CRLF is exactly one boundary");

        // CR|other split: the CR was lone; boundary at the chunk seam.
        let mut pending = false;
        let mut found = Vec::new();
        scan_line_breaks(b"aa\r", 0, &mut pending, |b| found.push(b));
        assert!(pending);
        scan_line_breaks(b"bb", 3, &mut pending, |b| found.push(b));
        assert!(!pending);
        assert_eq!(found, vec![3]);
    }

    #[test]
    fn split_str_lines_recognizes_lf_crlf_and_lone_cr() {
        assert_eq!(split_str_lines(""), Vec::<&str>::new());
        assert_eq!(split_str_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(
            split_str_lines("a\r\nb"),
            vec!["a", "b"],
            "CRLF is one terminator, not two lines plus an empty one"
        );
        assert_eq!(
            split_str_lines("a\rb"),
            vec!["a", "b"],
            "lone CR terminates a line (issue #162)"
        );
        assert_eq!(
            split_str_lines("a\nb\n"),
            vec!["a", "b"],
            "a final terminator does not produce a trailing empty line"
        );
        assert_eq!(
            split_str_lines("a\rb\rc\r"),
            vec!["a", "b", "c"],
            "a final lone CR is resolved as EOF, not left pending"
        );
    }

    /// Independent reference line table for the equivalence test below:
    /// mirrors `replaceinfiles.rs::split_line_segments` +
    /// `split_terminator` (content only, terminator stripped) using only
    /// `scan_line_breaks` directly, without calling `split_str_lines`
    /// itself — so the test below is a genuine cross-check between the
    /// byte-level path other callers use and the `&str`-level path
    /// `search.rs` uses, not the same code exercised twice.
    fn byte_line_contents(bytes: &[u8]) -> Vec<&[u8]> {
        if bytes.is_empty() {
            return Vec::new();
        }
        let mut ends: Vec<usize> = Vec::new();
        let mut pending_cr = false;
        scan_line_breaks(bytes, 0, &mut pending_cr, |b| ends.push(b as usize));
        if pending_cr {
            ends.push(bytes.len());
        }
        let mut lines = Vec::with_capacity(ends.len() + 1);
        let mut start = 0usize;
        for end in ends {
            let segment = &bytes[start..end];
            let content = if let Some(c) = segment.strip_suffix(b"\r\n") {
                c
            } else if let Some(c) = segment.strip_suffix(b"\n") {
                c
            } else if let Some(c) = segment.strip_suffix(b"\r") {
                c
            } else {
                segment
            };
            lines.push(content);
            start = end;
        }
        if start < bytes.len() {
            lines.push(&bytes[start..]);
        }
        lines
    }

    /// Locks `split_str_lines` (the `&str`-level path `search.rs` uses)
    /// against the byte-level line table every other caller
    /// (`replaceinfiles.rs`, `lineindex.rs`, `chunk.rs`) is built on, so
    /// the two can never silently drift apart and re-open issue #162's
    /// "Find and Replace disagree on line numbers" symptom. Covers plain
    /// LF/CRLF/lone-CR, mixed styles, no terminator at all, a final
    /// *unresolved* trailing CR (the EOF edge case both
    /// `split_line_segments` and `split_str_lines` resolve specially), and
    /// multi-byte UTF-8 content straddling lone-CR terminators.
    #[test]
    fn split_str_lines_agrees_with_byte_level_line_table() {
        let cases: &[&str] = &[
            "",
            "a",
            "a\n",
            "a\nb",
            "a\nb\n",
            "a\r\nb\r\n",
            "a\rb\rc",
            "a\rb\rc\r",
            "mixed\rstyles\r\nhere\nend",
            "a\rb\r\nc\nd\r",
            "\r",
            "\n",
            "\r\n",
            "\r\r",
            "\n\r",
            "xxx\r",
            "first\rneedle\rthird",
            "café\r日本語\rend",
        ];
        for &case in cases {
            let expected: Vec<&str> = byte_line_contents(case.as_bytes())
                .into_iter()
                .map(|b| std::str::from_utf8(b).expect("test fixtures are valid UTF-8"))
                .collect();
            let actual = split_str_lines(case);
            assert_eq!(
                actual, expected,
                "split_str_lines disagrees with the byte-level line table on {case:?}"
            );
        }
    }
}
