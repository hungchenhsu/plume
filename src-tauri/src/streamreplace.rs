//! Streaming find/replace over an entire file on disk, for the read-only
//! large-file preview window (ARCHITECTURE.md's large-file mode): the
//! in-editor Find/Replace can't be used there because only a bounded
//! slice of the file is ever loaded, and saving that slice back would
//! destroy the rest of the file. This command instead streams the whole
//! file from disk in bounded chunks, decodes, replaces, re-encodes, and
//! writes to a same-directory temp file — atomically renamed over the
//! original only once at least one replacement was made — so memory use
//! stays flat (`O(CHUNK_BYTES)`) regardless of file size, and a crash or
//! error mid-run can never leave a half-written file (Track B,
//! ROADMAP.md).
//!
//! `encoding` is the file's own on-disk encoding (the frontend passes the
//! open document's already-detected `doc.encoding`) — used for both
//! decoding and re-encoding. This command never converts between
//! encodings; see [`stream_replace_in_file`]'s doc comment for the full
//! safety discipline.
//!
//! UTF-16 is deliberately rejected up front (see
//! [`stream_replace_in_file`]): `Encoding::new_encoder()` returns an
//! encoder for the encoding's *output encoding*, and per encoding_rs's own
//! docs, "the output encoding of UTF-16BE, UTF-16LE, and replacement is
//! UTF-8" — there is no real UTF-16 encoder. Calling it naively here would
//! silently write UTF-8 bytes into a file labeled UTF-16, corrupting it.
//! `chunk.rs` already excludes UTF-16 from large-file paging for a related
//! reason (line alignment needs code-unit-aware boundaries); this follows
//! the same precedent rather than hand-rolling a manual UTF-16 streaming
//! encoder the way `encoding::encode_utf16` does for the (non-streaming,
//! whole-buffer) save path.
//!
//! Case-insensitive matching (`case_sensitive: false`) is ASCII-only
//! (`[u8]::eq_ignore_ascii_case`): non-ASCII characters always compare
//! exactly, never folded. Full Unicode case folding can change a string's
//! byte length (e.g. German "ß" uppercases to "SS"), which would break
//! this module's byte-offset bookkeeping; restricting folding to ASCII
//! (where upper/lower always occupy exactly one byte each) sidesteps that
//! trap entirely rather than working around it.
//!
//! The per-chunk decode/encode primitives (`decode_chunk`/`encode_chunk`/
//! `read_chunk`/`CHUNK_BYTES`) now live in `streamcodec.rs`, shared with
//! `streamconvert.rs`'s streaming encoding-conversion command (ROADMAP.md
//! v0.4 Track B) — extracted the same way `fsguard.rs` was pulled out of
//! this module for a second caller. Only the search/replace-specific
//! looping and carry semantics (`run_replace_loop`, `replace_pass`) stay
//! here.

use crate::fsguard::Fingerprint;
use crate::streamcodec::{decode_chunk, encode_chunk, read_chunk, CHUNK_BYTES};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};
use serde::Serialize;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamReplaceReport {
    pub replacements: u64,
    pub bytes_written: u64,
}

/// Result of one [`replace_pass`] over a work buffer.
struct PassResult {
    /// The fully-resolved region with all matches replaced.
    out: String,
    /// Number of replacements made within `out`.
    count: u64,
    /// Byte index into the input from which text must be carried into the
    /// next round unprocessed (`input.len()` when everything resolved —
    /// always the case for a final pass). Guaranteed to lie on a char
    /// boundary of the input.
    carry_from: usize,
}

/// One streaming pass of literal (non-regex) find/replace over `text`:
/// replaces every *resolvable* non-overlapping match left to right (the
/// same convention as `str::replace`) and reports where the unresolvable
/// tail begins. `case_sensitive: false` folds only the ASCII range
/// (`[u8]::eq_ignore_ascii_case`); see the module doc comment for why.
///
/// A match candidate (a position whose first byte matches `search`'s
/// first byte, exactly or ASCII-case-folded) is *resolvable* when the
/// full `search.len()`-byte window fits within `text` — every match is
/// exactly `search.len()` bytes, since both exact comparison and
/// ASCII-only folding are length-preserving. When a candidate's window
/// runs past the end of `text`:
///
/// - In a non-final pass (`is_final: false`), the missing tail may still
///   arrive with the next chunk, so the scan stops there: everything
///   before the candidate is resolved into `out`, and `carry_from` points
///   at the candidate so the caller re-presents `text[carry_from..]`
///   (plus the next chunk) in the next pass. Stopping at the *first* such
///   candidate is what makes the seam airtight: no candidate is ever
///   emitted as literal text while its window is still incomplete, so a
///   match can never lose its head to an earlier round — regardless of
///   whether it straddles the chunk seam itself or merely starts close to
///   it. (The obvious-looking alternative — splitting a fixed
///   `search.len() - 1` tail off first and searching only the prefix —
///   has a blind window: a match fully inside `text` that *starts* inside
///   the split-off region straddles the internal split and silently
///   escapes both the prefix search and the carry. See
///   `match_fully_inside_chunk_near_seam_is_found`, the regression lock
///   from the adversarial review that caught exactly that.)
/// - In a final pass (`is_final: true`), no more input is coming, so an
///   unfittable window can never complete: the candidate and everything
///   after it are literal text, and `carry_from` is `text.len()`.
///
/// `carry_from` is bounded: an unresolvable candidate sits within the
/// last `search.len() - 1` bytes of `text`, so the carried tail is
/// shorter than `search` — bounded by the (short, user-typed) search
/// string, not the chunk. (A search string longer than a whole chunk
/// degrades gracefully: the carry accumulates until a full window has
/// arrived, trading the flat-memory bound for correctness in a case no
/// interactive user hits.)
///
/// The byte-window scan (rather than a char-by-char one) is safe because
/// `search` is itself valid UTF-8: its first byte is never a UTF-8
/// continuation byte (0x80-0xBF), and `eq_ignore_ascii_case` only ever
/// folds ASCII bytes into other ASCII bytes (never into — or out of — a
/// continuation/lead byte). So every candidate position is a real char
/// boundary of `text` (also valid UTF-8) — which is also what guarantees
/// `carry_from` lands on one — and a full window match, by the same
/// argument applied to every byte in it, ends on one too. The loop below
/// never slices `text` mid-character.
///
/// Non-matching spans are located by scanning for a candidate first byte
/// and then bulk-copied with one `push_str`, rather than decoding and
/// pushing one character at a time: large filler stretches around a
/// handful of real matches (the common case for a big log file) are the
/// dominant cost otherwise, both for this module's own large-fixture tests
/// and — more importantly — for the actual multi-GB files this command
/// exists to serve.
fn replace_pass(
    text: &str,
    search: &str,
    replace: &str,
    case_sensitive: bool,
    is_final: bool,
) -> PassResult {
    let search_bytes = search.as_bytes();
    debug_assert!(
        !search_bytes.is_empty(),
        "search must be validated non-empty by the caller"
    );
    let slen = search_bytes.len();
    let first = search_bytes[0];
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut count = 0u64;
    let mut i = 0usize;

    while i < bytes.len() {
        let candidate = match bytes[i..].iter().position(|&b| {
            if case_sensitive {
                b == first
            } else {
                b.eq_ignore_ascii_case(&first)
            }
        }) {
            Some(rel) => i + rel,
            None => {
                // No possible match start in the rest: all resolved.
                out.push_str(&text[i..]);
                i = bytes.len();
                break;
            }
        };
        out.push_str(&text[i..candidate]);
        i = candidate;

        let window_end = i + slen;
        if window_end > bytes.len() {
            if is_final {
                // End of stream: this window can never complete, and no
                // later start could fit a full match either.
                out.push_str(&text[i..]);
                i = bytes.len();
            }
            // Non-final: stop here; text[i..] is carried into the next
            // round, where the window's missing tail will have arrived.
            break;
        }
        let window = &bytes[i..window_end];
        let matched = if case_sensitive {
            window == search_bytes
        } else {
            window.eq_ignore_ascii_case(search_bytes)
        };
        if matched {
            out.push_str(replace);
            count += 1;
            i = window_end;
        } else {
            let ch = text[i..]
                .chars()
                .next()
                .expect("i is a valid char boundary (see doc comment above)");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    PassResult {
        out,
        count,
        carry_from: i,
    }
}

/// Run the streaming decode -> replace -> encode loop, writing encoded
/// bytes to `tmp` as they're produced. `search`/`replace` have already
/// been validated by the caller (non-empty search, both representable in
/// `enc`). Returns `(replacements, bytes_written)`, where `bytes_written`
/// covers only what this function wrote — not any BOM prefix the caller
/// wrote to `tmp` beforehand.
///
/// The `carry` variable is the text-level companion to the `Decoder`'s own
/// internal byte-level carry: the decoder already handles a multi-byte
/// *character* split across a raw chunk boundary (that's what streaming
/// decoders are for), but a *match* of `search` can still straddle the
/// boundary between one chunk's decoded text and the next's. Each
/// non-final round therefore only resolves text up to the first match
/// candidate whose window hasn't fully arrived yet; that candidate and
/// everything after it are carried into the next round and re-presented
/// ahead of the next chunk's decoded text (see [`replace_pass`] for the
/// exact contract and why the carry is candidate-anchored rather than a
/// fixed-length tail). A match is never missed for falling near or across
/// a chunk seam (`match_spanning_chunk_boundary_is_found`,
/// `match_fully_inside_chunk_near_seam_is_found`).
fn run_replace_loop(
    source: &mut std::fs::File,
    tmp: &mut std::fs::File,
    enc: &'static Encoding,
    search: &str,
    replace: &str,
    case_sensitive: bool,
) -> Result<(u64, u64), String> {
    let mut decoder = enc.new_decoder_with_bom_removal();
    let mut encoder = enc.new_encoder();
    let mut carry = String::new();
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut replacements = 0u64;
    let mut bytes_written = 0u64;

    loop {
        let n = read_chunk(source, &mut buf).map_err(|e| format!("Failed to read: {e}"))?;
        let is_last = n < buf.len();
        let (decoded_text, had_errors) = decode_chunk(&mut decoder, &buf[..n], is_last);
        if had_errors {
            return Err(format!(
                "file does not decode cleanly as {}; aborted, file untouched",
                enc.name()
            ));
        }

        let work = carry + &decoded_text;
        let pass = replace_pass(&work, search, replace, case_sensitive, is_last);
        replacements += pass.count;

        let (out_bytes, had_unmappable) = encode_chunk(&mut encoder, &pass.out, is_last);
        if had_unmappable {
            return Err(format!(
                "content does not re-encode cleanly as {}; aborted, file untouched",
                enc.name()
            ));
        }
        tmp.write_all(&out_bytes)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        bytes_written += out_bytes.len() as u64;

        carry = work[pass.carry_from..].to_string();

        if is_last {
            debug_assert!(
                carry.is_empty(),
                "a final pass must resolve its entire input"
            );
            break;
        }
    }

    Ok((replacements, bytes_written))
}

/// Captured once at the start of a long streaming operation and re-checked
/// immediately before the final commit (`rename`), so an external
/// replacement of the file mid-run (log rotation, a formatter, a sync tool
/// doing an atomic rename over the same path — see issue #94) is detected
/// and aborted instead of being silently overwritten by this command
/// finishing its read of the now-stale open handle. See
/// [`capture_fingerprint`] and [`verify_unchanged`]; the fingerprint type
/// itself and its cross-platform identity discussion now live in
/// `fsguard.rs`, shared with the regular save path (issue #113).
///
/// Captures `file`'s fingerprint from its already-open handle rather than
/// re-`stat`ing the path, so the snapshot is tied to the exact file this
/// command opened and can never be confused with whatever the path
/// happens to resolve to later (see [`Fingerprint::from_file`]).
fn capture_fingerprint(file: &std::fs::File) -> std::io::Result<Fingerprint> {
    Fingerprint::from_file(file)
}

/// Fail closed if the file at `path` is no longer the file described by
/// `original` (see [`Fingerprint::matches_path`]). Any mismatch — including
/// `path` no longer existing at all — is treated as "changed": there is no
/// case where proceeding anyway is the safe choice once the on-disk
/// contents can no longer be shown to be the ones this run started with.
/// An `Ok` here still leaves the irreducible stat-to-rename TOCTOU window
/// open — this guard narrows the race, it cannot close it (see point 6 of
/// [`stream_replace_in_file`]'s doc comment and issue #102).
fn verify_unchanged(path: &Path, original: &Fingerprint) -> Result<(), String> {
    if original.matches_path(path) {
        Ok(())
    } else {
        Err("file changed on disk during replace; aborted, your file was not modified".to_string())
    }
}

/// Search-and-replace across an entire file on disk, streamed in bounded
/// chunks so memory use stays flat regardless of file size. Backend for
/// the large-file preview window's "Replace in Large File…" command.
///
/// Safety discipline, in order:
///
/// 1. `search` must be non-empty and `encoding` must name a known,
///    non-UTF-16 encoding (see the module doc comment for why UTF-16 is
///    rejected) — checked before anything is read from disk.
/// 2. `replace` is encode-checked in isolation first: if it contains a
///    character `encoding` can't represent, this returns `Err` and never
///    touches the file — a replacement can never partially land.
/// 3. `search` is also encode-checked: if `encoding` can't represent it,
///    no sequence of bytes that round-trips through `encoding` (which is
///    what every byte of this file does, having already been saved in it)
///    can ever decode to text containing `search` — so this returns `Ok`
///    with zero replacements without reading the file at all, rather than
///    erroring.
/// 4. The source is streamed and decoded; any malformed byte sequence
///    aborts immediately (temp file discarded, original untouched) rather
///    than writing back a partially-repaired file — matching
///    ARCHITECTURE.md's "decode errors are surfaced, never silently
///    rendered as if the text were fine".
/// 5. Re-encoding is defensively checked too: `replace` was already
///    validated in step 2, and every unreplaced *character* came from
///    decoding this file's own bytes in `encoding`, so it is by
///    construction representable in `encoding` again — this check exists
///    for defense in depth, not because failure is expected. Any
///    unmappable output still aborts rather than ever writing a lossy
///    byte the caller didn't explicitly agree to (mirrors
///    `save_document`'s `allow_lossy` gate in `lib.rs`, just with no lossy
///    path offered here at all). Representable is not the same as
///    byte-identical, though: several legacy encodings (Big5, Shift_JIS
///    and GBK among them — see `encoding::encode`'s round-trip contract
///    note and issue #96 for the full analysis) are not injective, so an
///    unreplaced byte sequence can
///    still come back out re-encoded to a different, canonical byte
///    sequence for the same character. This whole-file decode -> replace
///    -> re-encode was never scoped to leave non-matching bytes
///    untouched — see the module doc.
/// 6. Before that commit, the file at `path` is re-stat'd and compared
///    against the [`Fingerprint`] captured right after the source was
///    opened: if its size, mtime, or (Unix) inode identity no longer
///    match — including the file having been deleted outright — the temp
///    file is discarded and this returns `Err` without ever touching
///    `path`. This is what stops an external process that atomically
///    replaces the same path while a multi-GB stream is still in flight
///    (log rotation, a formatter, a sync tool) from having its newer
///    content silently overwritten once this command finally finishes
///    reading the now-stale open handle (issue #94). This narrows the race
///    to the microsecond-scale check-to-rename window rather than
///    eliminating it — no portable rename has an identity-conditional
///    variant — but that is a vast improvement over leaving the whole
///    multi-minute stream unguarded. See [`capture_fingerprint`] /
///    [`verify_unchanged`].
/// 7. Zero matches leaves the file completely untouched — no temp file
///    persists, no rename, `mtime` unchanged. Only a run with at least one
///    replacement commits: `sync_all`, the fingerprint check above, carry
///    over the original file's permissions, then `rename` over the
///    target — the same atomic discipline as `lib.rs::atomic_write`, just
///    fed by a temp file filled incrementally instead of from one
///    in-memory buffer.
///
/// BOM handling: up to 3 bytes (the longest BOM any encoding here uses —
/// UTF-8's `EF BB BF`) are peeked from the source first. If they form a
/// BOM for `enc` specifically, those exact bytes are written verbatim as
/// the first bytes of the temp file, and the streaming decoder — always
/// constructed in BOM-*removal* mode regardless of whether a BOM was
/// actually found — strips them back out of the decoded text it produces
/// from the start of the stream, so the search/replace pass never sees
/// them. This mirrors `encoding::decode_with`'s `had_bom` computation
/// (BOM must match the *specific* requested encoding, not just look like
/// some BOM) applied at streaming granularity instead of to a whole
/// in-memory buffer.
#[tauri::command]
pub fn stream_replace_in_file(
    path: String,
    search: String,
    replace: String,
    encoding: String,
    case_sensitive: bool,
) -> Result<StreamReplaceReport, String> {
    if search.is_empty() {
        return Err("Search text must not be empty".to_string());
    }
    let enc = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == UTF_16LE || enc == UTF_16BE {
        return Err("Replace in Large File is not supported for UTF-16 files".to_string());
    }

    // Step 2: the replacement text must be representable, or nothing runs.
    let (_, replace_unmappable) = crate::encoding::encode(&replace, enc.name(), false)?;
    if replace_unmappable {
        return Err(format!(
            "replacement contains characters not representable in {}",
            enc.name()
        ));
    }
    // Step 3: an unrepresentable search string can never match anything
    // that was itself saved in this encoding.
    let (_, search_unmappable) = crate::encoding::encode(&search, enc.name(), false)?;
    if search_unmappable {
        return Ok(StreamReplaceReport {
            replacements: 0,
            bytes_written: 0,
        });
    }

    let path_ref = Path::new(&path);
    let mut source =
        std::fs::File::open(path_ref).map_err(|e| format!("Failed to read {path}: {e}"))?;
    // Captured immediately after opening, from this exact handle, so it
    // describes the file this command is about to spend a potentially
    // long time streaming — not whatever the path resolves to later.
    // Compared against a fresh stat of `path` right before commit (see the
    // `replacements > 0` arm below) to fail closed if anything external
    // replaced the file in between (issue #94).
    let fingerprint =
        capture_fingerprint(&source).map_err(|e| format!("Failed to read {path}: {e}"))?;

    let mut peek = [0u8; 3];
    let peek_n =
        read_chunk(&mut source, &mut peek).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let bom_len = Encoding::for_bom(&peek[..peek_n])
        .filter(|(bom_enc, _)| *bom_enc == enc)
        .map(|(_, len)| len)
        .unwrap_or(0);
    source
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    let dir = path_ref.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path_ref
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let (mut tmp_file, tmp_path) = crate::create_tmp_exclusive(dir, &file_name)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    if bom_len > 0 {
        if let Err(e) = tmp_file.write_all(&peek[..bom_len]) {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to write temp file: {e}"));
        }
    }

    let outcome = run_replace_loop(
        &mut source,
        &mut tmp_file,
        enc,
        &search,
        &replace,
        case_sensitive,
    );

    match outcome {
        Ok((replacements, loop_bytes)) if replacements > 0 => {
            if let Err(e) = tmp_file.sync_all() {
                drop(tmp_file);
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Failed to write {path}: {e}"));
            }
            drop(tmp_file);
            if let Err(e) = verify_unchanged(path_ref, &fingerprint) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(e);
            }
            if let Ok(meta) = std::fs::metadata(path_ref) {
                let _ = std::fs::set_permissions(&tmp_path, meta.permissions());
            }
            if let Err(e) = std::fs::rename(&tmp_path, path_ref) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Failed to write {path}: {e}"));
            }
            Ok(StreamReplaceReport {
                replacements,
                bytes_written: bom_len as u64 + loop_bytes,
            })
        }
        Ok(_) => {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            Ok(StreamReplaceReport {
                replacements: 0,
                bytes_written: 0,
            })
        }
        Err(e) => {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("plume-streamreplace-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_no_leftover_tmp(dir: &std::path::Path) {
        let leftovers: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("plume-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp files may remain: {leftovers:?}"
        );
    }

    /// Core red-to-green case: a >10 MiB UTF-8 file with a known marker
    /// planted near the head, middle, and tail — guaranteeing occurrences
    /// land in more than one 8 MiB streaming chunk — replaced and verified
    /// both by count and by full-content equality against an
    /// independently computed `str::replace` oracle (which also pins that
    /// every byte *outside* the matches is unchanged).
    #[test]
    fn replaces_across_whole_large_utf8_file() {
        let dir = fixture_dir("utf8-whole-file");
        let file = dir.join("big.log");

        let line = "the quick brown fox jumps over the lazy dog\n";
        let lines_needed = (11 * 1024 * 1024) / line.len();
        let marker_at = [10usize, lines_needed / 2, lines_needed - 10];
        let mut content = String::with_capacity(lines_needed * line.len() + 256);
        for i in 0..lines_needed {
            if marker_at.contains(&i) {
                content.push_str("NEEDLE_MARKER token here\n");
            } else {
                content.push_str(line);
            }
        }
        assert!(
            content.len() as u64 > crate::LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let expected_count = content.matches("NEEDLE_MARKER").count() as u64;
        assert_eq!(expected_count, 3, "fixture must plant exactly 3 markers");
        let expected = content.replace("NEEDLE_MARKER", "REPLACED_TOKEN_XYZ");

        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NEEDLE_MARKER".to_string(),
            "REPLACED_TOKEN_XYZ".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, expected_count);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, expected, "every match replaced, rest unchanged");
        assert_eq!(report.bytes_written, on_disk.len() as u64);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Same shape as the UTF-8 case but in Big5 (2 bytes/char): a single
    /// repeated CJK filler character makes it trivial to splice markers at
    /// exact character boundaries while reaching a realistic >10 MiB
    /// on-disk size. Verifies the file stays Big5, decodes cleanly, and
    /// its length accounts exactly for the 3 replaced regions.
    ///
    /// The fixture is built by encoding each *distinct short string* once
    /// (the filler unit, the marker, the replacement — all a handful of
    /// bytes) and then repeating/splicing raw bytes, rather than running
    /// `encoding::encode` over the full ~17 MiB of UTF-8 text. The two are
    /// byte-identical (repeating "測" and then encoding is the same as
    /// encoding "測" and then repeating the 2-byte result), but
    /// encoding_rs's Big5 encoder is dramatically slower per byte than a
    /// raw `Vec<u8>` repeat in an unoptimized (`cargo test`, no
    /// `--release`) build — encoding the full string here was measured at
    /// ~48s on its own, which would make this single test dominate the
    /// whole crate's `cargo test` runtime for no additional coverage.
    #[test]
    fn replaces_in_big5_file_preserving_encoding() {
        let dir = fixture_dir("big5-whole-file");
        let file = dir.join("big.txt");

        let (filler_unit, unmappable) = crate::encoding::encode("測", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(filler_unit.len(), 2);
        let marker = "甲乙丙";
        let replacement = "丁戊己庚";
        let (marker_bytes, unmappable) = crate::encoding::encode(marker, "Big5", false).unwrap();
        assert!(!unmappable);
        let (replacement_bytes, unmappable) =
            crate::encoding::encode(replacement, "Big5", false).unwrap();
        assert!(!unmappable);

        let filler_bytes = filler_unit.repeat(5_600_000);
        let head = 300usize; // multiple of filler_unit.len() (2)
        let mid = ((filler_bytes.len() / 2) / 2) * 2;
        let tail = filler_bytes.len() - 300;

        let mut bytes = Vec::with_capacity(filler_bytes.len() + marker_bytes.len() * 3);
        bytes.extend_from_slice(&filler_bytes[..head]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[head..mid]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[mid..tail]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[tail..]);
        assert!(
            bytes.len() as u64 > crate::LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let (_, fixture_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(!fixture_malformed, "fixture must be well-formed Big5");
        std::fs::write(&file, &bytes).unwrap();

        let decoded_before = crate::encoding::decode_with(&bytes, "Big5").unwrap();
        assert!(!decoded_before.malformed);
        let expected_content = decoded_before.content.replace(marker, replacement);
        let expected_len = bytes.len() - 3 * marker_bytes.len() + 3 * replacement_bytes.len();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            marker.to_string(),
            replacement.to_string(),
            "Big5".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 3);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk.len(),
            expected_len,
            "byte length must reflect exactly the 3 replaced regions"
        );
        let decoded_after = crate::encoding::decode_with(&on_disk, "Big5").unwrap();
        assert!(!decoded_after.malformed);
        assert_eq!(decoded_after.content, expected_content);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The carry logic's do-or-die test: a pattern constructed so it
    /// straddles exactly the 8 MiB chunk boundary the source-read loop
    /// splits on. Before a correct carry, this pattern would be invisible
    /// to any single decode-and-search pass (half of it is in each raw
    /// chunk); after, it must be found exactly once.
    #[test]
    fn match_spanning_chunk_boundary_is_found() {
        let dir = fixture_dir("chunk-boundary");
        let file = dir.join("boundary.txt");

        let pattern = "BOUNDARY_MARKER_TOKEN";
        let half = pattern.len() / 2;
        let prefix_len = CHUNK_BYTES - half;
        let prefix = "a".repeat(prefix_len);
        let suffix = "b".repeat(4096);
        let content = format!("{prefix}{pattern}{suffix}");

        assert_eq!(&content[prefix_len..prefix_len + pattern.len()], pattern);
        assert!(
            prefix_len < CHUNK_BYTES && prefix_len + pattern.len() > CHUNK_BYTES,
            "the pattern must straddle the exact chunk boundary"
        );

        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            pattern.to_string(),
            "FOUND!".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(
            report.replacements, 1,
            "the boundary-spanning match must be found exactly once"
        );
        let expected = format!("{prefix}FOUND!{suffix}");
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, expected);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adversarial-review finding (P1): the companion blind spot the test
    /// above cannot see. A match that lies *fully inside* one chunk but
    /// starts within the last `search.len() - 1` bytes of the emitted
    /// prefix straddles the internal prefix/carry split rather than the
    /// chunk seam itself. The N-1-character carry design silently missed
    /// it: the match's head was emitted as literal text (its window didn't
    /// fit inside the prefix), while the carry only preserved text from
    /// the split point onward — so the next round never saw the head, and
    /// the occurrence was skipped without any error, undercounting a
    /// "replace all" the user believes was complete.
    ///
    /// For a 21-byte search, the blind start offsets were
    /// `[CHUNK_BYTES - 40, CHUNK_BYTES - 21]` (start inside the prefix's
    /// last N-1 bytes, end at or before the seam). One marker per file —
    /// the window is only N-1 positions wide, so two markers can't both
    /// fit in it — planted at each edge and the middle of that window.
    /// Red against the split-first carry design; green with the
    /// resolvable-prefix pass (`replace_pass`), which never emits a
    /// candidate whose window hasn't fully arrived.
    #[test]
    fn match_fully_inside_chunk_near_seam_is_found() {
        let pattern = "BOUNDARY_MARKER_TOKEN";
        assert_eq!(pattern.len(), 21);
        // Offsets of the match start *before* the seam, spanning the old
        // design's whole blind window [2N-2, N] plus its midpoint.
        for offset in [40usize, 30, 21] {
            let dir = fixture_dir(&format!("near-seam-{offset}"));
            let file = dir.join("nearseam.txt");

            let start = CHUNK_BYTES - offset;
            let prefix = "a".repeat(start);
            let suffix = "b".repeat(4096);
            let content = format!("{prefix}{pattern}{suffix}");
            assert!(
                start + pattern.len() <= CHUNK_BYTES,
                "offset {offset}: the match must end at or before the seam \
                 (fully inside chunk 1)"
            );
            std::fs::write(&file, content.as_bytes()).unwrap();

            let report = stream_replace_in_file(
                file.to_string_lossy().into_owned(),
                pattern.to_string(),
                "FOUND!".to_string(),
                "UTF-8".to_string(),
                true,
            )
            .unwrap();

            assert_eq!(
                report.replacements, 1,
                "offset {offset}: a match fully inside the chunk, starting \
                 near the seam, must be found exactly once"
            );
            let on_disk = std::fs::read_to_string(&file).unwrap();
            assert_eq!(
                on_disk,
                format!("{prefix}FOUND!{suffix}"),
                "offset {offset}"
            );

            assert_no_leftover_tmp(&dir);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn zero_matches_leaves_file_untouched() {
        let dir = fixture_dir("zero-matches");
        let file = dir.join("plain.txt");
        std::fs::write(&file, "nothing to see here, no matches at all\n").unwrap();
        let before_bytes = std::fs::read(&file).unwrap();
        let before_mtime = std::fs::metadata(&file).unwrap().modified().unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NOT_PRESENT".to_string(),
            "X".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 0);
        assert_eq!(report.bytes_written, 0);
        let after_bytes = std::fs::read(&file).unwrap();
        let after_mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(after_bytes, before_bytes);
        assert_eq!(after_mtime, before_mtime, "mtime must not be disturbed");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A stray `0x80` byte is below Big5's lead-byte floor (0x81) and is
    /// not a valid trail byte either, so splicing it into otherwise-valid
    /// Big5 content guarantees a malformed-sequence decode error (mirrors
    /// encoding.rs's own
    /// `extension_preference_falls_back_when_decode_would_be_malformed`
    /// fixture). The abort must happen without ever touching the original
    /// file or leaving a temp file behind.
    #[test]
    fn malformed_file_aborts_untouched() {
        let dir = fixture_dir("malformed");
        let file = dir.join("bad.txt");

        let text = "正常的中文內容在這裡，這是一段測試文字。";
        let (mut bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let insert_at = bytes.len() / 2;
        bytes.insert(insert_at, 0x80);
        let (_, big5_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(big5_malformed, "fixture must actually be malformed as Big5");

        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "中文".to_string(),
            "英文".to_string(),
            "Big5".to_string(),
            true,
        );

        assert!(result.is_err(), "malformed source must abort with Err");
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, bytes,
            "original bytes must be untouched after an abort"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_unmappable_in_target_encoding_errors() {
        let dir = fixture_dir("replace-unmappable");
        let file = dir.join("doc.txt");
        let text = "純中文內容，沒有問題。";
        let (bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "中文".to_string(),
            "🚀 rocket".to_string(),
            "Big5".to_string(),
            true,
        );

        let err = result.expect_err("emoji replacement must be rejected for Big5");
        assert!(
            err.contains("not representable"),
            "error should explain why: {err}"
        );
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, bytes,
            "file must be untouched when the replacement is rejected"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bom_preserved_when_present() {
        let dir = fixture_dir("bom-preserved");
        let file = dir.join("withbom.txt");
        let text = "line one has a MARKER in it\nline two does not\nline three has a MARKER too\n";
        let (bytes, unmappable) = crate::encoding::encode(text, "UTF-8", true).unwrap();
        assert!(!unmappable);
        assert_eq!(&bytes[..3], [0xEF, 0xBB, 0xBF]);
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            "TOKEN".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 2);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            &on_disk[..3],
            [0xEF, 0xBB, 0xBF],
            "BOM must survive the replace"
        );
        let decoded = crate::encoding::decode_auto(&on_disk);
        assert_eq!(decoded.encoding, "UTF-8");
        assert!(decoded.had_bom);
        assert_eq!(decoded.content, text.replace("MARKER", "TOKEN"));

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Deliberate scope decision, not an oversight (see the module doc
    /// comment): `Encoding::new_encoder()` has no real UTF-16 encoder, so
    /// this command must refuse UTF-16 outright rather than silently write
    /// UTF-8 bytes into a file labeled UTF-16.
    #[test]
    fn rejects_utf16_target_encoding() {
        let dir = fixture_dir("utf16-rejected");
        let file = dir.join("doc.txt");
        let (bytes, _) = crate::encoding::encode("hello world", "UTF-16LE", true).unwrap();
        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "hello".to_string(),
            "hi".to_string(),
            "UTF-16LE".to_string(),
            true,
        );
        assert!(result.is_err());
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk, bytes, "rejected file must be untouched");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_must_not_be_empty() {
        let result = stream_replace_in_file(
            "/nonexistent/path/does/not/matter.txt".to_string(),
            String::new(),
            "x".to_string(),
            "UTF-8".to_string(),
            true,
        );
        assert!(result.is_err());
    }

    /// Small-scale contract tests for `replace_pass`, the unit the
    /// streaming loop's correctness rests on. Each simulated "next round"
    /// re-presents `text[carry_from..]` plus newly arrived text, exactly
    /// as `run_replace_loop` does.
    #[test]
    fn replace_pass_carries_from_unresolved_candidate() {
        // Non-final: a candidate ('A') whose window runs off the end must
        // not be emitted; everything before it resolves.
        let pass = replace_pass("xxxAB", "ABCD", "*", true, false);
        assert_eq!(pass.out, "xxx");
        assert_eq!(pass.count, 0);
        assert_eq!(pass.carry_from, 3);

        // Next round: carry + newly decoded text completes the match.
        let work = format!("{}{}", "AB", "CDyy");
        let pass = replace_pass(&work, "ABCD", "*", true, true);
        assert_eq!(pass.out, "*yy");
        assert_eq!(pass.count, 1);
        assert_eq!(pass.carry_from, work.len());

        // A match fully inside the text but starting within the last
        // search.len()-1 bytes must resolve in the same pass (the old
        // fixed-length-tail carry missed exactly this shape). The
        // trailing 'y' is no candidate ('A'), so it resolves too.
        let pass = replace_pass("xxABCDy", "ABCD", "*", true, false);
        assert_eq!(pass.out, "xx*y");
        assert_eq!(pass.count, 1);
        assert_eq!(pass.carry_from, 7);

        // Failed candidate at the very end, final pass: emitted literally.
        let pass = replace_pass("xxxAB", "ABCD", "*", true, true);
        assert_eq!(pass.out, "xxxAB");
        assert_eq!(pass.count, 0);
        assert_eq!(pass.carry_from, 5);

        // Case-insensitive candidate anchoring must use the same fold as
        // the window comparison: 'a' anchors a carry for search "AB".
        let pass = replace_pass("xxxa", "AB", "*", false, false);
        assert_eq!(pass.out, "xxx");
        assert_eq!(pass.carry_from, 3);

        // No candidate anywhere: everything resolves, empty carry.
        let pass = replace_pass("xxxx", "AB", "*", true, false);
        assert_eq!(pass.out, "xxxx");
        assert_eq!(pass.carry_from, 4);
    }

    /// `case_sensitive: false` exercised directly: ASCII letters fold
    /// regardless of case, but an adjacent non-ASCII character (Latin
    /// capital É) is never touched by the search or folded into a match.
    #[test]
    fn case_insensitive_ascii_match_ignores_case_but_not_unicode() {
        let dir = fixture_dir("case-insensitive");
        let file = dir.join("doc.txt");
        let text = "Hello world, HELLO again, hello café HELLO_CAFÉ done";
        std::fs::write(&file, text.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "hello".to_string(),
            "hi".to_string(),
            "UTF-8".to_string(),
            false,
        )
        .unwrap();

        assert_eq!(report.replacements, 4);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, "hi world, hi again, hi café hi_CAFÉ done");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Happy-path pin for the fingerprint mechanism added for issue #94:
    /// an ordinary replace with no external interference must still
    /// succeed end-to-end through the real public command — the
    /// commit-time `verify_unchanged` check must not false-positive on a
    /// file nobody else touched.
    #[test]
    fn replace_succeeds_when_file_unchanged() {
        let dir = fixture_dir("fingerprint-happy-path");
        let file = dir.join("doc.txt");
        std::fs::write(&file, "alpha NEEDLE beta NEEDLE gamma\n").unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NEEDLE".to_string(),
            "FOUND".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 2);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, "alpha FOUND beta FOUND gamma\n");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Core red-to-green regression for issue #94 (P1 data loss): a file
    /// externally replaced via atomic rename — the exact mechanism log
    /// rotation, formatters, and sync tools use — while a stream_replace
    /// run is (hypothetically) still in flight must be detected at
    /// commit time and must never be overwritten.
    ///
    /// `stream_replace_in_file` itself is synchronous end-to-end, so there
    /// is no real yield point to interleave an external rename mid-run
    /// without either (a) racing a background thread against it — flaky,
    /// since on a fast filesystem the whole streaming pass can complete
    /// before the race window opens — or (b) adding test-only
    /// instrumentation (a hook or a generic `Read` parameter) to
    /// `run_replace_loop` purely to enable this test, which is more
    /// production-code surface than a P1 fail-closed fix should carry.
    /// Both were rejected in favor of the approach the task's own design
    /// pre-approved: exercise `capture_fingerprint` /
    /// `verify_unchanged` — the exact two functions
    /// `stream_replace_in_file` calls at the start and right before
    /// `rename` — directly, against a *real* external rename (not a
    /// hand-constructed mismatch; that is covered separately by the
    /// `verify_unchanged_detects_*` tests below). This proves the
    /// detection logic is correct against the genuine OS-level mechanism.
    /// The remaining gap — that `stream_replace_in_file` actually calls
    /// these two functions at the right spots with the right arguments —
    /// is a few lines, directly readable in the diff, and is also
    /// covered indirectly: `replace_succeeds_when_file_unchanged` would
    /// fail if the wiring called `verify_unchanged` with a stale or wrong
    /// path/fingerprint.
    #[cfg(unix)]
    #[test]
    fn replace_aborts_when_file_replaced_during_operation() {
        let dir = fixture_dir("external-replace");
        let file = dir.join("target.txt");
        std::fs::write(&file, b"original content, unchanged\n").unwrap();

        // Mirrors stream_replace_in_file's own opening sequence: open the
        // source handle, then immediately capture its fingerprint.
        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = capture_fingerprint(&source).unwrap();

        // While the replace is (hypothetically) still streaming, another
        // process atomically replaces the same path — e.g. log rotation,
        // a formatter, a sync tool — via rename, exactly as issue #94
        // describes. `source` keeps referring to the original inode (Unix
        // fd semantics), which is precisely the hazard: naively finishing
        // the read and renaming the temp file over `path` would clobber
        // this newer content.
        let replacement = dir.join("replacement.txt");
        std::fs::write(&replacement, b"newer content from another process\n").unwrap();
        std::fs::rename(&replacement, &file).unwrap();

        let result = verify_unchanged(&file, &fingerprint);
        assert!(
            result.is_err(),
            "an externally-renamed-in file must be detected as changed"
        );

        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, b"newer content from another process\n",
            "the externally-written content must survive untouched"
        );

        drop(source);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_unchanged_detects_size_change() {
        let dir = fixture_dir("verify-size");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = capture_fingerprint(&source).unwrap();

        fingerprint.len += 1;

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_unchanged_detects_mtime_change() {
        let dir = fixture_dir("verify-mtime");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = capture_fingerprint(&source).unwrap();

        fingerprint.modified.secs -= 3600;

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn verify_unchanged_detects_identity_change() {
        let dir = fixture_dir("verify-identity");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = capture_fingerprint(&source).unwrap();

        fingerprint.identity = (
            fingerprint.identity.0,
            fingerprint.identity.1.wrapping_add(1),
        );

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Design point 2's other fail-closed case: the path disappearing
    /// entirely mid-run (not just being replaced) must also abort rather
    /// than proceed.
    #[test]
    fn verify_unchanged_detects_deleted_file() {
        let dir = fixture_dir("verify-deleted");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = capture_fingerprint(&source).unwrap();

        std::fs::remove_file(&file).unwrap();

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
