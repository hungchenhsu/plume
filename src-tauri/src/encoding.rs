//! Encoding detection, decoding and encoding for document I/O.
//!
//! Detection order: BOM sniffing first, then statistical detection via
//! chardetng. Decoded text is normalized to LF; the original line ending is
//! reported separately so it can be restored on save.
//!
//! ## Round-trip contract
//!
//! What this module — and every whole-buffer save path built on it
//! (`lib.rs::save_document`, `batch.rs::convert_one`,
//! `streamreplace.rs`'s whole-file decode/re-encode) — actually
//! guarantees on a decode -> encode cycle is: the decoded *text*, the
//! *encoding label*, the *BOM flag*, and the *line ending* all survive
//! unchanged. It does **not** guarantee byte-for-byte identity of the
//! re-encoded output against the original on-disk bytes. `encoding_rs`
//! (0.8.35, per `Cargo.lock`) follows the WHATWG Encoding Standard, and
//! for a handful of legacy multi-byte encodings that standard's decode
//! mapping is not injective: more than one on-disk byte sequence can
//! decode to the same Unicode character (duplicate or vendor-extension
//! mappings), while `encode` always emits only that character's single
//! canonical byte sequence. So `encode(decode(bytes)) != bytes` is
//! possible even when decoding reports no malformed data and encoding
//! reports nothing unmappable — a non-canonical input sequence is
//! silently canonicalized. See the `tests` module below (`big5_`,
//! `shift_jis_`, `gbk_non_canonical_bytes_are_canonicalized_on_encode`)
//! for three currently-observed, pinned examples, and issue #96 for the
//! full analysis. Mitigations shipped for #96: `streamreplace.rs` now
//! byte-passes-through unmatched self-sufficient chunks instead of
//! re-encoding them, and `bytedrift.rs::check_byte_drift` gives the
//! user a one-time informed-consent warning before the first save of a
//! file whose bytes would be canonicalized.

use chardetng::EncodingDetector;
use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8,
};

pub struct DecodedText {
    pub content: String,
    pub encoding: String,
    pub had_bom: bool,
    pub malformed: bool,
}

/// Reason `Detection::chosen` was picked: a BOM was found, a per-extension
/// preference decoded the sample cleanly, chardetng made a statistical
/// call, or there were no bytes to analyze (empty input).
pub const REASON_BOM: &str = "bom";
pub const REASON_EXTENSION: &str = "extension";
pub const REASON_DETECTOR: &str = "detector";
pub const REASON_FALLBACK: &str = "fallback";

/// Evidence gathered while auto-detecting an encoding: what BOM (if any)
/// was found, what chardetng concluded from the sample, and which of the
/// two `decode_auto` actually used to decode.
pub struct Detection {
    pub bom: Option<&'static Encoding>,
    pub detector_guess: &'static Encoding,
    pub chosen: &'static Encoding,
    pub reason: &'static str,
}

/// Run chardetng over `bytes` and return its guess.
fn detector_guess(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true)
}

/// Sniff a BOM and run chardetng over `bytes`, returning the full evidence
/// behind the detection `decode_auto_with_extension` would use — including
/// a per-extension encoding preference (e.g. the user set ".txt" to always
/// open as Big5), passed as `ext_encoding` (`None` when the file's
/// extension has no mapping). Shared by `decode_auto_with_extension`
/// (which only needs `chosen`) and the `explain_detection` diagnostics
/// command (which reports all of it), so both stay in lockstep by
/// construction. Decision order:
///
/// 1. A BOM always wins, regardless of `ext_encoding` — it is
///    unambiguous ground truth about the bytes.
/// 2. With no BOM, if the sample is valid UTF-8 *containing multi-byte
///    sequences*, it is treated as confident UTF-8 and `ext_encoding` is
///    not consulted: real-world non-UTF-8 legacy text is essentially
///    never byte-valid multi-byte UTF-8, whereas short genuine UTF-8
///    (e.g. "測試", 6 bytes) can decode through Big5/GBK/Shift_JIS with
///    no malformed sequences yet completely wrong text — the malformed
///    flag alone cannot catch that, this gate does. Detection proceeds
///    to the statistical guess (`REASON_DETECTOR`), which reads such
///    input as UTF-8.
/// 3. If `ext_encoding` resolves to UTF-16LE or UTF-16BE and the sample
///    is valid UTF-8 (pure ASCII and the empty sample both count), the
///    hint is rejected outright without even attempting to decode it
///    (issue #47). ASCII is a safe subset of every other encoding this
///    table can name — rule 4 relies on that — but not of UTF-16: any
///    even-length sample is byte-valid as UTF-16 (every byte pair is a
///    legal code unit) yet decodes to unrelated characters (e.g. "ab"
///    -> U+6261) with no malformed sequence to catch it. Detection
///    falls through to rule 5/6.
/// 4. Otherwise (pure ASCII, or bytes that are not valid UTF-8), if
///    `ext_encoding` names a known encoding and decoding the full sample
///    with it produces no malformed sequences, it wins
///    (`REASON_EXTENSION`). For pure ASCII this changes no character —
///    the listed legacy encodings (other than UTF-16, excluded by rule
///    3) are ASCII-compatible — but it pins the save-default encoding
///    the user wants for that extension.
/// 5. If `ext_encoding` is absent, unknown, or decodes the sample with
///    malformed sequences, the preference is rejected and detection
///    falls back to the statistical guess (`REASON_DETECTOR`).
/// 6. Empty input with no usable `ext_encoding` has no evidence to
///    analyze (`REASON_FALLBACK`). With one, rule 4 applies unless it
///    names UTF-16 (rule 3) — an empty file trivially decodes cleanly,
///    so a non-UTF-16 preference names it; a UTF-16 preference is
///    rejected just like any other valid-UTF-8 sample and the empty
///    file falls back.
pub fn detect_with_extension(bytes: &[u8], ext_encoding: Option<&str>) -> Detection {
    let guess = detector_guess(bytes);
    if let Some((encoding, _bom_len)) = Encoding::for_bom(bytes) {
        return Detection {
            bom: Some(encoding),
            detector_guess: guess,
            chosen: encoding,
            reason: REASON_BOM,
        };
    }
    // UTF-8 gate (rule 2): valid UTF-8 with at least one non-ASCII byte
    // is confident UTF-8; never let an extension preference reinterpret
    // it as a legacy encoding.
    let valid_utf8 = std::str::from_utf8(bytes).is_ok();
    let confident_utf8 = !bytes.is_ascii() && valid_utf8;
    if !confident_utf8 {
        if let Some(label) = ext_encoding {
            if let Some(encoding) = Encoding::for_label(label.as_bytes()) {
                // UTF-16 guard (issue #47): unlike the legacy single/
                // double-byte encodings this preference table otherwise
                // names (Big5, Shift_JIS, ...), ASCII is not a safe
                // subset of UTF-16. Every even-length ASCII/UTF-8 sample
                // is byte-valid as UTF-16 (any two bytes form a legal
                // code unit), but decoding it as UTF-16 reinterprets it
                // as entirely different characters (e.g. "ab" ->
                // U+6261) with malformed=false and no signal anything
                // went wrong. Rejecting a UTF-16 hint whenever the bytes
                // are valid UTF-8 closes that hole; real-world UTF-16
                // files almost always carry a BOM (handled above), and
                // a BOM-less UTF-16 file with non-ASCII content is not
                // valid UTF-8, so this costs nothing there. The residual
                // trade-off — a hand-crafted, BOM-less, ASCII-only
                // UTF-16 file also reads as valid UTF-8 and loses the
                // hint too — is accepted: such a file is
                // indistinguishable from ASCII text containing literal
                // NUL bytes, and is far rarer than the silent-corruption
                // case this guard exists to prevent.
                let is_utf16 = encoding == UTF_16LE || encoding == UTF_16BE;
                if !(is_utf16 && valid_utf8) {
                    let (_, malformed) = encoding.decode_without_bom_handling(bytes);
                    if !malformed {
                        return Detection {
                            bom: None,
                            detector_guess: guess,
                            chosen: encoding,
                            reason: REASON_EXTENSION,
                        };
                    }
                }
            }
        }
    }
    let reason = if bytes.is_empty() {
        REASON_FALLBACK
    } else {
        REASON_DETECTOR
    };
    Detection {
        bom: None,
        detector_guess: guess,
        chosen: guess,
        reason,
    }
}

/// Decode bytes by sniffing a BOM first and falling back to chardetng.
/// Equivalent to `decode_auto_with_extension(bytes, None)`.
pub fn decode_auto(bytes: &[u8]) -> DecodedText {
    decode_auto_with_extension(bytes, None)
}

/// Same as `decode_auto`, but honoring a per-extension encoding preference
/// per the decision order documented on `detect_with_extension`.
pub fn decode_auto_with_extension(bytes: &[u8], ext_encoding: Option<&str>) -> DecodedText {
    let detection = detect_with_extension(bytes, ext_encoding);
    let encoding = detection.chosen;
    let (content, malformed) = if detection.bom.is_some() {
        encoding.decode_with_bom_removal(bytes)
    } else {
        encoding.decode_without_bom_handling(bytes)
    };
    DecodedText {
        content: content.into_owned(),
        encoding: encoding.name().to_string(),
        had_bom: detection.bom.is_some(),
        malformed,
    }
}

/// Human-readable description of a BOM for diagnostics, e.g.
/// "UTF-8 BOM (EF BB BF)". Returns `None` when no BOM was found.
pub fn describe_bom(bytes: &[u8]) -> Option<String> {
    let (encoding, bom_len) = Encoding::for_bom(bytes)?;
    let hex = bytes[..bom_len]
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("{} BOM ({hex})", encoding.name()))
}

/// Which UTF-16 byte order a document uses, when known. Only the two
/// UTF-16 variants need this distinction: they are the only encodings this
/// app supports where one logical newline is a two-byte code unit rather
/// than a single byte, so a raw byte window (as `lib.rs::preview_slice`
/// cuts for a large-file preview) must be aligned to code-unit boundaries
/// instead of searched for a lone `0x0A` — see `utf16_variant` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Utf16Variant {
    Le,
    Be,
}

/// Decide which UTF-16 byte order (if any) a large-file preview should
/// align its cut point to — called on the raw bytes *before* decoding,
/// using the same signal precedence the real decode uses:
///
/// 1. An explicit encoding label (set when the user reopens a file with a
///    chosen encoding) wins outright. `decode_with` never consults the BOM
///    to *pick* an encoding, only to decide whether to strip it, so this
///    must not fall back to sniffing the BOM when a label is present, even
///    if that label names a non-UTF-16 encoding.
/// 2. With no explicit label, auto-detection's own first signal applies: a
///    BOM sniff, exactly as `detect_with_extension` checks `Encoding::
///    for_bom` before anything else.
/// 3. Otherwise `None` — including a BOM-less UTF-16 file with no explicit
///    label. chardetng's statistical guess never calls UTF-16, so treating
///    unlabeled, BOM-less bytes as UTF-16 here would be a guess this
///    function has no basis for.
pub fn utf16_variant(raw: &[u8], explicit_label: Option<&str>) -> Option<Utf16Variant> {
    if let Some(label) = explicit_label {
        return match Encoding::for_label(label.as_bytes()) {
            Some(enc) if enc == UTF_16LE => Some(Utf16Variant::Le),
            Some(enc) if enc == UTF_16BE => Some(Utf16Variant::Be),
            _ => None,
        };
    }
    match Encoding::for_bom(raw) {
        Some((enc, _)) if enc == UTF_16LE => Some(Utf16Variant::Le),
        Some((enc, _)) if enc == UTF_16BE => Some(Utf16Variant::Be),
        _ => None,
    }
}

/// Whether an encoding label names UTF-8 — any alias `encoding_rs`
/// recognizes (e.g. "utf-8", "UTF8"), resolved the same way `decode_with`
/// itself resolves a label, so a caller deciding whether UTF-8-only
/// preprocessing (like `trim_truncated_utf8_tail`) applies can never
/// disagree with what the real decode is about to do. An unknown label is
/// not UTF-8 by definition here; `decode_with` surfaces the "unknown
/// encoding" error separately.
pub fn is_utf8_label(label: &str) -> bool {
    Encoding::for_label(label.as_bytes()) == Some(UTF_8)
}

/// Whether an encoding label names one of the legacy multi-byte encodings
/// `trim_truncated_legacy_tail` knows how to trim a truncated preview tail
/// for: Big5, Shift_JIS, GBK, gb18030, EUC-JP, EUC-KR. Resolved through
/// `Encoding::for_label` exactly like `is_utf8_label`, so a caller (the
/// `open_document` trim gate) can never disagree with what `decode_with`
/// is about to do for the same label.
///
/// Deliberately excludes, all on purpose rather than by omission:
/// - Single-byte encodings (windows-1252 and friends): every byte already
///   *is* one whole character, so a raw preview cut can never split one —
///   there is nothing to trim, ever.
/// - UTF-8 and UTF-16: each already has its own dedicated, more direct
///   gate (`is_utf8_label`; the `utf16` parameter threaded through
///   `preview_slice` and `open_document`'s trim gate).
/// - ISO-2022-JP: the one `encoding_rs` encoding whose *decoder* is
///   genuinely stateful — a shift escape sequence changes the meaning of
///   every subsequent byte for the rest of the stream, not just the next
///   character (see `streamreplace.rs`'s module doc comment, and the
///   judgment-overlay dead-end this repeats) — so there is no fixed
///   per-character byte bound to retry cuts against the way there is for
///   the other legacy encodings here. Left with its pre-existing
///   (untrimmed) preview behavior; issue #165 does not claim to fix it.
pub fn is_legacy_multibyte_label(label: &str) -> bool {
    Encoding::for_label(label.as_bytes()).is_some_and(|enc| max_legacy_seq_len(enc).is_some())
}

/// The longest byte length of a single character's encoded sequence in
/// one of the legacy multi-byte encodings `is_legacy_multibyte_label` /
/// `trim_truncated_legacy_tail` support, or `None` for every other
/// encoding (see `is_legacy_multibyte_label`'s doc comment for why each
/// is excluded). Per the WHATWG Encoding Standard's index tables: Big5,
/// Shift_JIS, GBK, and EUC-KR are 1 or 2 bytes per character; EUC-JP is
/// 1, 2, or 3 (its JIS X 0212 plane, reached via a `0x8F` lead byte, is
/// the only 3-byte case); gb18030 is 1, 2, or 4 (its four-byte plane
/// covers the rest of Unicode; unlike EUC-JP it has no 3-byte case).
fn max_legacy_seq_len(enc: &'static Encoding) -> Option<usize> {
    if enc == GB18030 {
        Some(4)
    } else if enc == EUC_JP {
        Some(3)
    } else if enc == BIG5 || enc == SHIFT_JIS || enc == GBK || enc == EUC_KR {
        Some(2)
    } else {
        None
    }
}

/// Trim a trailing UTF-8 multibyte sequence that is incomplete *only
/// because the input was truncated at its end*, returning the longest
/// valid-UTF-8 prefix in that case and `bytes` unchanged otherwise. The
/// discriminator is the shape of `str::from_utf8`'s error, not a byte
/// count: an `Err` whose `error_len()` is `None` is the documented
/// "unexpected end of input" case — the bytes are valid UTF-8 up to
/// `valid_up_to()` (then guaranteed 1..=3 bytes from the end) and only
/// the final multibyte sequence was cut off. An `Err` with `error_len()
/// == Some(_)` is a genuine invalid byte in the *interior* and is left
/// in place, as is fully-valid UTF-8. (`error_len()` is preferred over a
/// "how far from the end" heuristic precisely because it stays correct
/// for short inputs, where an interior error can coincidentally sit near
/// the end.)
///
/// This exists for the large-file preview path (issues #47 / #71). That
/// path detects an encoding on a bounded ~2 MiB window whose tail can
/// fall mid-character; run directly, `detect_with_extension` would see
/// that window as invalid UTF-8, miss its confident-UTF-8 gate (rule 2),
/// and let a UTF-16 (or any) extension hint reinterpret a perfectly good
/// UTF-8 file as mojibake with `malformed == false` and no U+FFFD — the
/// exact silent-corruption hole the #47 gate closes for small files.
/// Trimming the truncated tail first realigns the window's UTF-8
/// validity with the whole file's, so detection reaches the verdict it
/// would on the complete file. The distinction from genuine BOM-less
/// UTF-16 is exactly what `error_len()` captures: real UTF-16 of any
/// non-ASCII text has an invalid *interior* byte within its first code
/// units, so it is never mistaken for a truncated-UTF-8 tail and its
/// hint still resolves. Trimming at most 3 bytes at an already-arbitrary
/// truncation boundary is cosmetically negligible for any other encoding.
pub fn trim_truncated_utf8_tail(bytes: &[u8]) -> &[u8] {
    match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
        _ => bytes,
    }
}

/// Mirror of `trim_truncated_utf8_tail` for the *leading* edge of a
/// buffer. This exists for large-file chunk paging (`chunk.rs`, issue
/// #118): a single line longer than one chunk has no terminator to align
/// a read to, so a later chunk simply continues from wherever the
/// previous one's raw byte count left off, and that raw cut can land
/// mid-character. The leading bytes of such a buffer are then a
/// character's orphaned continuation bytes (0x80-0xBF) — its lead byte
/// was already consumed (and, on the tail side, replaced by
/// `trim_truncated_utf8_tail`) in the previous chunk. A valid UTF-8
/// sequence has at most 3 continuation bytes (a 4-byte sequence's lead
/// byte is followed by 3), so scanning at most 3 bytes in is always
/// enough.
///
/// Unlike `trim_truncated_utf8_tail`, this does not re-verify the result
/// against `str::from_utf8` on the whole buffer — a full validity check
/// would immediately fail on the *rest* of an arbitrarily-cut 2 MiB
/// buffer for unrelated reasons (a lone CR, or simply landing mid another
/// multibyte encoding's sequence) and so cannot distinguish "orphaned
/// leading continuation bytes" from "any other reason the buffer isn't
/// valid UTF-8" the way `trim_truncated_utf8_tail`'s `error_len().is_none()`
/// check does for a *trailing* truncation. Callers therefore only use
/// this once they already know, from the document's own resolved
/// encoding (not a guess), that the content is UTF-8 — a bare byte-range
/// check would otherwise misfire on other multibyte encodings whose own
/// trail bytes legitimately fall in 0x80-0xBF (e.g. Big5).
pub fn trim_truncated_utf8_head(bytes: &[u8]) -> &[u8] {
    let scan = bytes.len().min(3);
    let orphaned = bytes[..scan]
        .iter()
        .take_while(|&&b| (0x80..0xC0).contains(&b))
        .count();
    &bytes[orphaned..]
}

/// Trim a trailing multi-byte sequence from `bytes` that is incomplete
/// only because the input was truncated at its end, for one of the
/// legacy multi-byte encodings `is_legacy_multibyte_label` names (Big5,
/// Shift_JIS, GBK, gb18030, EUC-JP, EUC-KR) — `label` is resolved the
/// same way `decode_with` resolves it. Returns `bytes` unchanged if
/// `label` does not resolve to one of those encodings: a defensive
/// no-op, since callers are expected to gate on `is_legacy_multibyte_label`
/// first, as `open_document`'s trim gate in `lib.rs` does.
///
/// This is the legacy-encoding sibling of `trim_truncated_utf8_tail`
/// (issue #165, following #136's UTF-8 fix). UTF-8's version leans on
/// `str::from_utf8`'s `error_len()` as a free, structural oracle for "ran
/// out of input mid-character" versus "genuinely invalid byte" (see that
/// function's doc comment); `encoding_rs`'s legacy multi-byte decoders
/// expose no equivalent, and hand-writing one from each encoding's own
/// lead/trail byte tables was rejected (issue #165's "修法方向") as
/// high-maintenance and easy to get subtly wrong for six different
/// encodings. This uses decode semantics instead, in two steps:
///
/// 1. **Rule out genuine corruption anywhere in `bytes`.** Feed the whole
///    slice through a fresh streaming `Decoder` with `last: false` (“more
///    input might still follow” — see `decode_chunk` in
///    `streamcodec.rs`, reused here unmodified). A streaming decoder only
///    ever flags a malformed sequence for a byte that is invalid
///    *regardless of what follows* — never for a valid-so-far prefix
///    that simply ran out of buffer at a boundary it was told is not
///    necessarily the real end of the stream. This is the exact
///    `encoding_rs` behavior `streamreplace.rs::chunk_is_decode_self_sufficient`
///    already relies on, used here in mirror image: that function forces
///    `last: true` on an isolated chunk to *detect* a pending tail; this
///    forces `last: false` over the *whole* slice to *rule out* any
///    position-independent error before ever considering a trim. If this
///    step reports any malformed sequence, it is a genuine error
///    somewhere in `bytes` — interior or not — and `bytes` is returned
///    unchanged so the real decode surfaces it, exactly as #136's
///    interior-malformed principle requires. This is a stricter
///    discriminator than "malformed disappears after trimming within the
///    encoding's max sequence length" alone would be: without it, a
///    genuinely corrupt byte that happened to fall in the last one to
///    three positions of the window would be indistinguishable from a
///    truncated sequence and silently trimmed away instead of surfaced —
///    the exact silent-corruption shape ARCHITECTURE.md's hard
///    constraint forbids.
/// 2. **Find the exact trim depth.** Once step 1 has ruled out genuine
///    corruption anywhere in `bytes`, any malformed sequence a
///    *forced-final* (`last: true`) decode reports can only be that
///    trailing incomplete sequence. Retry increasingly deep cuts from
///    the tail — `bytes` itself first (cut depth 0, the common case
///    where the window already ends cleanly), then 1 byte short, up to
///    `max_legacy_seq_len(enc) - 1` bytes short (a valid sequence can
///    never be missing *all* of its own bytes) — and return the first
///    (shallowest) cut whose forced-final decode comes back clean.
///    `open_document`'s `next_offset` is derived from the returned
///    slice's own length, so a trimmed open still hands the next chunk
///    read a character-aligned offset too (mirroring #136).
///
/// Cost: up to `max_legacy_seq_len(enc) + 1` whole-slice decodes — step 1,
/// plus at most `max_legacy_seq_len(enc)` retries in step 2 (the loop
/// tries cut depth 0 first, which is also charged to this budget) — at
/// most 5 total, for gb18030. This only runs on the narrow path
/// `open_document` gates it behind (issue #165): a preview window with no
/// newline to cut at, for a file already over `LARGE_FILE_THRESHOLD`,
/// explicitly reopened as one of these encodings. A handful of decodes of
/// one ~2 MiB window on that path costs tens of milliseconds, not a hot
/// path anywhere else — recorded here as the accepted trade-off issue
/// #165 called for instead of six sets of hand-written lead/trail tables.
pub fn trim_truncated_legacy_tail<'a>(bytes: &'a [u8], label: &str) -> &'a [u8] {
    let Some(enc) = Encoding::for_label(label.as_bytes()) else {
        return bytes;
    };
    let Some(max_len) = max_legacy_seq_len(enc) else {
        return bytes;
    };
    if bytes.is_empty() {
        return bytes;
    }
    let mut probe = enc.new_decoder_without_bom_handling();
    let (_, genuinely_malformed) = crate::streamcodec::decode_chunk(&mut probe, bytes, false);
    if genuinely_malformed {
        return bytes;
    }
    let max_cut = max_len.saturating_sub(1).min(bytes.len());
    for cut_len in 0..=max_cut {
        let candidate = &bytes[..bytes.len() - cut_len];
        if enc
            .decode_without_bom_handling_and_without_replacement(candidate)
            .is_some()
        {
            return candidate;
        }
    }
    // Step 1 already ruled out genuine corruption anywhere in `bytes`, so
    // every cut depth up to `max_len - 1` still failing here should not
    // be reachable in practice — but if it somehow is, leave `bytes`
    // unchanged rather than guess further; the real decode below then
    // reports `malformed` truthfully instead of this function silently
    // picking a boundary it isn't sure of.
    bytes
}

/// Decide which UTF-16 byte order (if any) a large-file preview should
/// align its cut point to, additionally folding in a per-extension
/// encoding preference (`ext_encoding`) when auto-detecting. Closes the
/// gap `utf16_variant` alone leaves open for issue #71: a BOM-less
/// UTF-16 file that auto-detection picks up only through `ext_encoding`
/// (see `detect_with_extension` rule 4) still needs its preview cut
/// aligned to UTF-16 code units, but `utf16_variant`'s signal set —
/// explicit label, else BOM — never sees that hint at all, so the
/// preview fell back to a raw `0x0A` search that (issue #61) lands mid
/// code-unit on real UTF-16 content almost every time.
///
/// 1. An explicit reopen label wins outright, delegated to
///    `utf16_variant` unchanged — this only adds a signal, it does not
///    reorder the existing ones.
/// 2. No explicit label and no `ext_encoding`: the only signal left is
///    the BOM, so this also just delegates to `utf16_variant` rather
///    than pay for a `detect_with_extension` pass that cannot conclude
///    anything new.
/// 3. No explicit label but `ext_encoding` is present: run the real
///    `detect_with_extension` — the exact function and precedence (BOM,
///    then the #47 UTF-8 gate, then the hint, then the statistical
///    fallback) the eventual decode uses — and translate a UTF-16LE/BE
///    verdict into the matching variant. Because it is the *same*
///    guarded function, a hint over content that is valid UTF-8 is
///    rejected here exactly as it would be for the real decode.
///
/// The sample handed to step 3 is `raw` conditioned two ways, both so
/// the probe judges the *content* rather than an artifact of where the
/// preview bound fell:
///
/// - Trimmed to even length (`len & !1`). `lib.rs::open_document`'s
///   bounded read carries one sentinel byte past the window when the
///   file continues; an odd length always trials as a *malformed*
///   UTF-16 decode (a dangling code unit) and would wrongly reject a
///   genuine UTF-16 hint.
/// - Then `trim_truncated_utf8_tail`. Without it, a large *valid* UTF-8
///   file whose 2 MiB tail merely splits a multibyte character reads as
///   invalid UTF-8 here, dodges the confident-UTF-8 gate, and — because
///   3-byte-script UTF-8 bytes (E0-EF / 80-BF) never land in the
///   surrogate high-byte range D8-DF, so a UTF-16 trial decode of them
///   never reports malformed — is mis-probed as UTF-16 and its whole
///   preview silently rendered as mojibake (the P1 regression a naive
///   #71 fix reopened). The real decode avoids this only because its
///   slice is cut at a newline (a clean UTF-8 boundary); this probe runs
///   on the pre-slice window and so must realign explicitly.
///   `open_document` applies the same trim to the real decode for the
///   no-newline single-line case, which the cut alone cannot clean up.
pub fn preview_utf16_variant(
    raw: &[u8],
    explicit_label: Option<&str>,
    ext_encoding: Option<&str>,
) -> Option<Utf16Variant> {
    if explicit_label.is_some() || ext_encoding.is_none() {
        return utf16_variant(raw, explicit_label);
    }
    let even = &raw[..raw.len() & !1];
    let sample = trim_truncated_utf8_tail(even);
    match detect_with_extension(sample, ext_encoding).chosen {
        enc if enc == UTF_16LE => Some(Utf16Variant::Le),
        enc if enc == UTF_16BE => Some(Utf16Variant::Be),
        _ => None,
    }
}

/// Decode bytes with an encoding explicitly chosen by the user.
pub fn decode_with(bytes: &[u8], label: &str) -> Result<DecodedText, String> {
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {label}"))?;
    let had_bom = matches!(Encoding::for_bom(bytes), Some((bom, _)) if bom == encoding);
    let (content, malformed) = if had_bom {
        encoding.decode_with_bom_removal(bytes)
    } else {
        encoding.decode_without_bom_handling(bytes)
    };
    Ok(DecodedText {
        content: content.into_owned(),
        encoding: encoding.name().to_string(),
        had_bom,
        malformed,
    })
}

/// Encode text for saving. Returns the bytes and whether any character was
/// unmappable in the target encoding (the caller should warn the user).
///
/// Not guaranteed to be byte-identical to whatever bytes (if any) `text`
/// was originally decoded from — see the module doc's "Round-trip
/// contract" section for the known non-injective-mapping gap (issue #96).
pub fn encode(text: &str, label: &str, with_bom: bool) -> Result<(Vec<u8>, bool), String> {
    let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {label}"))?;

    // encoding_rs follows the WHATWG spec and cannot encode to UTF-16, so
    // UTF-16 output is produced manually here.
    if encoding == UTF_16LE || encoding == UTF_16BE {
        return Ok((encode_utf16(text, encoding == UTF_16BE, with_bom), false));
    }

    let (bytes, _, unmappable) = encoding.encode(text);
    let mut out = Vec::with_capacity(bytes.len() + 3);
    if with_bom && encoding == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(&bytes);
    Ok((out, unmappable))
}

/// `pub(crate)` (not just a private helper of `encode` above) so
/// `charinspect.rs`'s `encode_char` can reuse this exact hand-rolled
/// code-unit encoder for its own UTF-16LE/BE branch instead of
/// re-deriving the same bit-twiddling — see that module's doc comment for
/// why it must not call `encoding_rs`'s `new_encoder()`/`encode()` for
/// UTF-16 at all.
pub(crate) fn encode_utf16(text: &str, big_endian: bool, with_bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    let units = with_bom
        .then_some(0xFEFFu16)
        .into_iter()
        .chain(text.encode_utf16());
    for unit in units {
        let pair = if big_endian {
            unit.to_be_bytes()
        } else {
            unit.to_le_bytes()
        };
        out.extend_from_slice(&pair);
    }
    out
}

/// Classify the dominant line ending of raw decoded text: a pure style —
/// `"LF"`, `"CRLF"`, or `"CR"` (lone `\r` not followed by `\n`: Classic Mac
/// line endings, or a stray CR) — when exactly one style is present in the
/// text, `"Mixed"` when more than one is, and `"LF"` (the pre-existing
/// default) when the text has no line endings at all.
///
/// Byte-scanning (not char-scanning) is safe here: `\r` and `\n` are ASCII,
/// and no UTF-8 continuation or lead byte of a multi-byte sequence can
/// equal an ASCII byte value, so splitting on them never misreads a
/// multi-byte character as a line ending.
pub fn detect_line_ending(text: &str) -> &'static str {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lone_cr = 0usize;
    let mut lone_lf = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 2;
            }
            b'\r' => {
                lone_cr += 1;
                i += 1;
            }
            b'\n' => {
                lone_lf += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    match (crlf > 0, lone_cr > 0, lone_lf > 0) {
        (false, false, false) => "LF", // no line endings at all; pre-existing default
        (true, false, false) => "CRLF",
        (false, true, false) => "CR",
        (false, false, true) => "LF",
        _ => "Mixed",
    }
}

/// Normalize CRLF and lone CR to LF for the in-memory document. The order
/// matters: collapsing `\r\n` pairs first guarantees every `\r` left over
/// for the second `replace` is a lone CR, so it too becomes a single `\n`
/// rather than contributing to a double newline.
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Apply the requested line ending to LF-normalized text before encoding.
pub fn apply_line_ending(text: &str, line_ending: &str) -> String {
    match line_ending {
        "CRLF" => text.replace('\n', "\r\n"),
        "CR" => text.replace('\n', "\r"),
        _ => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Detection with no per-extension preference, as `search.rs` and any
    /// caller of plain `decode_auto` exercise it.
    fn detect(bytes: &[u8]) -> Detection {
        detect_with_extension(bytes, None)
    }

    #[test]
    fn detects_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.content, "hi");
        assert_eq!(decoded.encoding, "UTF-8");
        assert!(decoded.had_bom);
    }

    #[test]
    fn detects_big5_from_realistic_sample() {
        // Statistical detection needs a realistic amount of text; a few
        // bytes are genuinely ambiguous across legacy encodings.
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.encoding, "Big5");
        assert_eq!(decoded.content, text);
    }

    #[test]
    fn explicit_decode_rejects_unknown_label() {
        assert!(decode_with(b"hi", "not-an-encoding").is_err());
    }

    /// `detect().chosen` must always agree with `decode_auto`'s reported
    /// encoding — `explain_detection` reports the former, `open_document`
    /// decodes with the latter, and they must never disagree.
    #[test]
    fn detect_agrees_with_decode_auto_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let detection = detect(&bytes);
        assert_eq!(detection.chosen.name(), decode_auto(&bytes).encoding);
        assert_eq!(detection.reason, REASON_BOM);
        assert_eq!(detection.bom.unwrap().name(), "UTF-8");
        assert_eq!(
            describe_bom(&bytes).as_deref(),
            Some("UTF-8 BOM (EF BB BF)")
        );
    }

    #[test]
    fn detect_agrees_with_decode_auto_utf16le_bom() {
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        let detection = detect(&bytes);
        assert_eq!(detection.chosen.name(), decode_auto(&bytes).encoding);
        assert_eq!(detection.reason, REASON_BOM);
        assert_eq!(detection.bom.unwrap().name(), "UTF-16LE");
        assert_eq!(
            describe_bom(&bytes).as_deref(),
            Some("UTF-16LE BOM (FF FE)")
        );
    }

    #[test]
    fn detect_agrees_with_decode_auto_plain_ascii() {
        let bytes = b"hello world, this is plain ascii text with no accents";
        let detection = detect(bytes);
        assert_eq!(detection.chosen.name(), decode_auto(bytes).encoding);
        assert_eq!(detection.reason, REASON_DETECTOR);
        assert!(detection.bom.is_none());
        assert_eq!(describe_bom(bytes), None);
    }

    #[test]
    fn detect_agrees_with_decode_auto_big5_sample() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let detection = detect(&bytes);
        assert_eq!(detection.chosen.name(), decode_auto(&bytes).encoding);
        assert_eq!(detection.chosen.name(), "Big5");
        assert_eq!(detection.reason, REASON_DETECTOR);
        assert!(detection.bom.is_none());
    }

    #[test]
    fn detect_agrees_with_decode_auto_empty_file() {
        let bytes: [u8; 0] = [];
        let detection = detect(&bytes);
        assert_eq!(detection.chosen.name(), decode_auto(&bytes).encoding);
        assert_eq!(detection.reason, REASON_FALLBACK);
        assert!(detection.bom.is_none());
        assert_eq!(describe_bom(&bytes), None);
    }

    #[test]
    fn round_trips_big5() {
        let (bytes, unmappable) = encode("中文", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(decode_with(&bytes, "Big5").unwrap().content, "中文");
    }

    #[test]
    fn round_trips_utf16le_with_bom() {
        let (bytes, _) = encode("中文", "UTF-16LE", true).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.content, "中文");
        assert!(decoded.had_bom);
    }

    #[test]
    fn utf16_variant_prefers_explicit_label_over_bom() {
        // Explicit "UTF-16BE" wins even though the bytes carry a UTF-16LE
        // BOM: `decode_with` never consults the BOM to pick an encoding,
        // only to decide whether to strip it, so this must match.
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        assert_eq!(
            utf16_variant(&bytes, Some("UTF-16BE")),
            Some(Utf16Variant::Be)
        );
        assert_eq!(
            utf16_variant(&bytes, Some("UTF-16LE")),
            Some(Utf16Variant::Le)
        );
    }

    #[test]
    fn utf16_variant_explicit_non_utf16_label_does_not_fall_back_to_bom() {
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        assert_eq!(utf16_variant(&bytes, Some("Big5")), None);
    }

    #[test]
    fn utf16_variant_sniffs_bom_when_no_explicit_label() {
        let (le_bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        assert_eq!(utf16_variant(&le_bytes, None), Some(Utf16Variant::Le));
        let (be_bytes, _) = encode("hi", "UTF-16BE", true).unwrap();
        assert_eq!(utf16_variant(&be_bytes, None), Some(Utf16Variant::Be));
        assert_eq!(utf16_variant(b"plain ascii", None), None);
    }

    #[test]
    fn classifies_line_endings() {
        assert_eq!(detect_line_ending("a\nb\n"), "LF");
        assert_eq!(detect_line_ending("a\r\nb\r\n"), "CRLF");
        assert_eq!(detect_line_ending("a\r\nb\n"), "Mixed");
        assert_eq!(detect_line_ending("no newline"), "LF");
    }

    /// Issue #82: lone `\r` (Classic Mac / stray CR) was entirely
    /// invisible to `detect_line_ending`, which only ever counted `\n`.
    /// A CR-only file misreported "LF", and a file mixing CR with any
    /// other style misreported whatever `\n`-based verdict fell out of
    /// the old two-counter logic.
    #[test]
    fn classifies_lone_cr_and_cr_mixes() {
        assert_eq!(detect_line_ending("a\rb\r"), "CR");
        assert_eq!(detect_line_ending("a\r\nb\r"), "Mixed");
        assert_eq!(detect_line_ending("a\rb\n"), "Mixed");
        assert_eq!(detect_line_ending("a\rb\r\nc"), "Mixed");
    }

    #[test]
    fn applies_crlf_on_save() {
        assert_eq!(apply_line_ending("a\nb", "CRLF"), "a\r\nb");
        assert_eq!(apply_line_ending("a\nb", "LF"), "a\nb");
        assert_eq!(apply_line_ending("a\nb", "CR"), "a\rb");
    }

    /// Round trip through the same path a CR-only file takes when its
    /// line ending is unified on save/batch-convert: decode -> normalize
    /// to LF for the in-memory buffer -> re-apply "CR" on save must
    /// reproduce the original bytes exactly.
    #[test]
    fn cr_round_trips_through_normalize_and_apply() {
        let original = "a\rb\rc\r";
        let normalized = normalize_to_lf(original);
        assert_eq!(
            normalized, "a\nb\nc\n",
            "normalize_to_lf must turn lone CR into LF"
        );
        assert_eq!(apply_line_ending(&normalized, "CR"), original);
    }

    // --- Per-extension encoding preference: decision order -------------
    //
    // 1. BOM always wins, even over an extension preference.
    // 2. Valid non-ASCII UTF-8 is confident UTF-8 -> ext preference is
    //    not consulted (the malformed flag alone cannot catch short UTF-8
    //    that happens to be byte-valid in a legacy encoding).
    // 3. Otherwise, ext preference decoding cleanly -> ext wins.
    // 4. Ext preference producing malformed output -> falls back to
    //    statistical detection (never overridden into mojibake).
    // 5. No ext preference at all -> unchanged from plain `detect`.

    #[test]
    fn extension_preference_loses_to_bom() {
        // UTF-8 BOM present, but the extension preference says Big5. The
        // BOM must win regardless.
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let detection = detect_with_extension(&bytes, Some("Big5"));
        assert_eq!(detection.reason, REASON_BOM);
        assert_eq!(detection.chosen.name(), "UTF-8");
    }

    #[test]
    fn extension_preference_wins_when_it_decodes_cleanly() {
        // No BOM; content really is Big5. The extension preference should
        // be honored and reported as such.
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let detection = detect_with_extension(&bytes, Some("Big5"));
        assert_eq!(detection.reason, REASON_EXTENSION);
        assert_eq!(detection.chosen.name(), "Big5");
        let decoded = decode_auto_with_extension(&bytes, Some("Big5"));
        assert_eq!(decoded.encoding, "Big5");
        assert_eq!(decoded.content, text);
        assert!(!decoded.malformed);
    }

    #[test]
    fn long_utf8_text_is_not_hijacked_by_extension_preference() {
        // No BOM; content is genuine multi-byte UTF-8, but the extension
        // preference (wrongly) says Big5. The UTF-8 gate must keep this
        // out of the preference's reach and detection must report UTF-8.
        // (For this long fixture Big5 decoding also happens to be
        // malformed, so rule 4 would catch it too — the short-text test
        // above covers the case where only the gate can.)
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let bytes = text.as_bytes();

        let detection = detect_with_extension(bytes, Some("Big5"));
        assert_eq!(detection.reason, REASON_DETECTOR);
        assert_eq!(detection.chosen.name(), "UTF-8");

        let decoded = decode_auto_with_extension(bytes, Some("Big5"));
        assert_eq!(decoded.encoding, "UTF-8");
        assert_eq!(decoded.content, text);
        assert!(!decoded.malformed);
    }

    #[test]
    // The from_utf8 call on a known-invalid literal is intentional: it
    // pins the fixture's premise (clippy::invalid_from_utf8 flags it as
    // always-erroring, which is exactly the point).
    #[allow(invalid_from_utf8)]
    fn extension_preference_falls_back_when_decode_would_be_malformed() {
        // Bytes that are neither valid UTF-8 (lone 0x80 continuation
        // byte) nor valid Big5 (0x80 is below the 0x81 lead-byte floor):
        // the UTF-8 gate does not fire, the preference is tried, decoding
        // reports malformed, and detection must fall back to the
        // statistical guess instead of honoring the preference.
        let bytes = [b'a', 0x80, b'b'];
        assert!(std::str::from_utf8(&bytes).is_err());
        let (_, big5_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(
            big5_malformed,
            "test fixture must actually be malformed as Big5"
        );

        let detection = detect_with_extension(&bytes, Some("Big5"));
        assert_eq!(detection.reason, REASON_DETECTOR);
        assert_ne!(detection.chosen.name(), "Big5");
    }

    #[test]
    fn short_utf8_text_is_not_hijacked_by_extension_preference() {
        // Verifier-found hole in the malformed-flag check alone: short
        // valid UTF-8 like "測試" (6 bytes) decodes through Big5 with
        // malformed=false but completely wrong text ("皜祈岫"). Valid
        // non-ASCII UTF-8 must therefore be treated as confident UTF-8:
        // the extension preference must not apply, and the file must open
        // as UTF-8 with its content intact.
        for text in ["測試", "中", "日本語", "한국어 메모"] {
            let bytes = text.as_bytes();
            if text == "測試" {
                // Pin that this fixture really is the trap: Big5 accepts
                // the bytes cleanly yet produces different text.
                let (as_big5, malformed) = encoding_rs::BIG5.decode_without_bom_handling(bytes);
                assert!(!malformed, "fixture must decode via Big5 without errors");
                assert_ne!(as_big5, text, "fixture must be mojibake as Big5");
            }

            let detection = detect_with_extension(bytes, Some("Big5"));
            assert_eq!(
                detection.chosen.name(),
                "UTF-8",
                "{text:?} must stay UTF-8 despite the Big5 extension preference"
            );
            assert_ne!(detection.reason, REASON_EXTENSION);

            let decoded = decode_auto_with_extension(bytes, Some("Big5"));
            assert_eq!(decoded.encoding, "UTF-8");
            assert_eq!(decoded.content, text);
            assert!(!decoded.malformed);
        }
    }

    #[test]
    fn pure_ascii_still_honors_extension_preference() {
        // The UTF-8 gate only fires on multi-byte sequences: pure ASCII
        // decodes identically in every ASCII-compatible encoding, so the
        // preference still applies — it costs nothing on open and pins
        // the encoding the file will be saved back with.
        let bytes = b"plain ascii log line, no accents at all";
        let detection = detect_with_extension(bytes, Some("Big5"));
        assert_eq!(detection.reason, REASON_EXTENSION);
        assert_eq!(detection.chosen.name(), "Big5");

        let decoded = decode_auto_with_extension(bytes, Some("Big5"));
        assert_eq!(decoded.encoding, "Big5");
        assert_eq!(decoded.content, "plain ascii log line, no accents at all");
        assert!(!decoded.malformed);
    }

    #[test]
    fn extension_preference_ignored_when_unknown_label() {
        let bytes = b"hello world, this is plain ascii text with no accents";
        let detection = detect_with_extension(bytes, Some("not-an-encoding"));
        assert_eq!(detection.reason, REASON_DETECTOR);
    }

    #[test]
    fn no_extension_preference_matches_plain_detect() {
        let bytes = b"hello world, this is plain ascii text with no accents";
        let with_none = detect_with_extension(bytes, None);
        let plain = detect(bytes);
        assert_eq!(with_none.reason, plain.reason);
        assert_eq!(with_none.chosen.name(), plain.chosen.name());
    }

    #[test]
    fn extension_preference_applies_to_empty_input() {
        // Empty bytes decode cleanly with any encoding, so rule 2 applies:
        // an empty .txt whose extension maps to Big5 is treated as Big5
        // (matching what the user wants that file to be), not the
        // no-evidence fallback — that stays reserved for empty files with
        // no preference.
        let detection = detect_with_extension(&[], Some("Big5"));
        assert_eq!(detection.reason, REASON_EXTENSION);
        assert_eq!(detection.chosen.name(), "Big5");
        let plain = detect_with_extension(&[], None);
        assert_eq!(plain.reason, REASON_FALLBACK);
    }

    // --- Round-trip tests -------------------------------------------------

    #[test]
    fn round_trips_big5_via_extension_preference() {
        // Big5 sample, ".txt" configured to Big5: open (auto-detect with
        // the preference) -> save -> reopen must preserve content and
        // encoding.
        let text = "中文編碼偵測測試，這是繁體中文範例文字。";
        let (original_bytes, unmappable) = encode(text, "Big5", false).unwrap();
        assert!(!unmappable);

        let opened = decode_auto_with_extension(&original_bytes, Some("Big5"));
        assert_eq!(opened.encoding, "Big5");
        assert_eq!(opened.content, text);

        let (saved_bytes, unmappable) = encode(&opened.content, &opened.encoding, false).unwrap();
        assert!(!unmappable);
        assert_eq!(saved_bytes, original_bytes);

        let reopened = decode_auto_with_extension(&saved_bytes, Some("Big5"));
        assert_eq!(reopened.encoding, "Big5");
        assert_eq!(reopened.content, text);
        assert!(!reopened.malformed);
    }

    #[test]
    fn utf8_file_with_wrong_extension_preference_does_not_open_as_mojibake() {
        // Legitimate UTF-8 multi-byte content, but ".txt" is (wrongly)
        // configured to Big5. Opening must not silently render mojibake —
        // detection must fall back and the round trip must preserve the
        // original UTF-8 text.
        let text = "中文編碼偵測測試，這是繁體中文範例文字。";
        let original_bytes = text.as_bytes().to_vec();

        let opened = decode_auto_with_extension(&original_bytes, Some("Big5"));
        assert_eq!(opened.encoding, "UTF-8");
        assert_eq!(opened.content, text);
        assert!(!opened.malformed);

        let (saved_bytes, unmappable) = encode(&opened.content, &opened.encoding, false).unwrap();
        assert!(!unmappable);
        assert_eq!(saved_bytes, original_bytes);
    }

    // --- Issue #47: UTF-16 extension hint must not hijack ASCII/UTF-8 ---
    //
    // The UTF-8 gate above (rule 2) only fires on *non-ASCII* valid UTF-8:
    // pure ASCII intentionally still falls through to the extension
    // preference (see `pure_ascii_still_honors_extension_preference`),
    // because ASCII is a subset of every legacy single/double-byte
    // encoding this preference table names — a hint of Big5 or Shift_JIS
    // decodes ASCII bytes to the same text. ASCII is *not* a subset of
    // UTF-16: any even-length byte string is byte-valid as UTF-16 (every
    // pair of bytes is a legal code unit), but decoding it as UTF-16
    // reinterprets it as entirely different characters. A UTF-16 hint
    // needs its own guard.

    #[test]
    fn utf16_ext_hint_never_hijacks_even_length_ascii() {
        // 6 bytes, pure ASCII, even length. Before the fix this decoded
        // through the extension hint as UTF-16LE/BE, turning "ab\ncd\n"
        // into entirely different characters (bytes 0x61 0x62 -> U+6261)
        // with malformed=false and no signal anything went wrong.
        let text = "ab\ncd\n";
        let bytes = text.as_bytes();
        assert_eq!(bytes.len(), 6, "fixture must be even-length");
        assert!(bytes.is_ascii(), "fixture must be pure ASCII");

        for label in ["UTF-16LE", "UTF-16BE"] {
            let detection = detect_with_extension(bytes, Some(label));
            assert_eq!(
                detection.reason, REASON_DETECTOR,
                "{label} hint must be rejected and fall back to the statistical detector"
            );
            assert_ne!(detection.chosen.name(), "UTF-16LE");
            assert_ne!(detection.chosen.name(), "UTF-16BE");

            let decoded = decode_auto_with_extension(bytes, Some(label));
            assert_eq!(
                decoded.content, text,
                "{label} hint must not corrupt plain ASCII content"
            );
            assert!(!decoded.malformed);
        }
    }

    #[test]
    fn utf16_ext_hint_never_hijacks_valid_multibyte_utf8() {
        // Even-length, genuine multi-byte UTF-8 (Chinese). This is already
        // protected by the existing confident-UTF-8 gate (rule 2), which
        // fires on any non-ASCII valid UTF-8 regardless of what the
        // extension hint names — already-locked behavior, pinned here
        // specifically for a UTF-16 hint.
        let text = "中文";
        let bytes = text.as_bytes();
        assert_eq!(bytes.len(), 6, "fixture must be even-length");

        for label in ["UTF-16LE", "UTF-16BE"] {
            let detection = detect_with_extension(bytes, Some(label));
            assert_eq!(detection.chosen.name(), "UTF-8");
            assert_ne!(detection.reason, REASON_EXTENSION);

            let decoded = decode_auto_with_extension(bytes, Some(label));
            assert_eq!(decoded.encoding, "UTF-8");
            assert_eq!(decoded.content, text);
            assert!(!decoded.malformed);
        }
    }

    #[test]
    fn utf16_ext_hint_still_applies_to_real_utf16_without_bom() {
        // Genuine UTF-16 content with no BOM: non-ASCII text makes the
        // byte-interleaved result invalid UTF-8, so the guard above must
        // not fire and the hint must still apply — the legitimate use case
        // the guard must not break.
        let text = "中文";

        let (le_bytes, _) = encode(text, "UTF-16LE", false).unwrap();
        assert!(
            std::str::from_utf8(&le_bytes).is_err(),
            "fixture must not be valid UTF-8"
        );
        let detection = detect_with_extension(&le_bytes, Some("UTF-16LE"));
        assert_eq!(detection.reason, REASON_EXTENSION);
        assert_eq!(detection.chosen.name(), "UTF-16LE");
        let decoded = decode_auto_with_extension(&le_bytes, Some("UTF-16LE"));
        assert_eq!(decoded.content, text);
        assert!(!decoded.malformed);

        let (be_bytes, _) = encode(text, "UTF-16BE", false).unwrap();
        assert!(
            std::str::from_utf8(&be_bytes).is_err(),
            "fixture must not be valid UTF-8"
        );
        let detection = detect_with_extension(&be_bytes, Some("UTF-16BE"));
        assert_eq!(detection.reason, REASON_EXTENSION);
        assert_eq!(detection.chosen.name(), "UTF-16BE");
        let decoded = decode_auto_with_extension(&be_bytes, Some("UTF-16BE"));
        assert_eq!(decoded.content, text);
        assert!(!decoded.malformed);
    }

    #[test]
    fn utf16_ext_hint_bom_still_wins() {
        // UTF-16LE BOM present, but the extension preference says
        // UTF-16BE. The BOM must win regardless — existing, unconditional
        // behavior (the BOM check returns before the hint is even read).
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        let detection = detect_with_extension(&bytes, Some("UTF-16BE"));
        assert_eq!(detection.reason, REASON_BOM);
        assert_eq!(detection.chosen.name(), "UTF-16LE");

        let decoded = decode_auto_with_extension(&bytes, Some("UTF-16BE"));
        assert_eq!(decoded.encoding, "UTF-16LE");
        assert_eq!(decoded.content, "hi");
        assert!(!decoded.malformed);
    }

    /// Empty input is trivially valid UTF-8, so the UTF-16 guard rejects
    /// the hint and — with nothing for the detector to analyze — the
    /// decision lands on the fallback (doc rule 6). Locks the corner the
    /// adversarial review found asserted only in prose.
    #[test]
    fn utf16_ext_hint_on_empty_file_falls_back() {
        for label in ["UTF-16LE", "UTF-16BE"] {
            let detection = detect_with_extension(b"", Some(label));
            assert_eq!(detection.reason, REASON_FALLBACK);
            assert_ne!(detection.chosen.name(), "UTF-16LE");
            assert_ne!(detection.chosen.name(), "UTF-16BE");
        }
    }

    // --- Issue #71: the large-file preview cut variant must fold in a
    // per-extension hint the same way the real decode does, so the two
    // can never disagree ---

    #[test]
    fn preview_utf16_variant_prefers_explicit_label_over_ext_hint() {
        // An explicit reopen label (e.g. the user picked "UTF-16BE" from
        // the menu) must win outright, exactly as `utf16_variant` alone
        // already guarantees — a conflicting ext hint must not change
        // that.
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        assert_eq!(
            preview_utf16_variant(&bytes, Some("UTF-16BE"), Some("Big5")),
            Some(Utf16Variant::Be)
        );
    }

    #[test]
    fn preview_utf16_variant_uses_ext_hint_for_real_utf16_without_bom() {
        // The gap issue #71 closes: no explicit label, no BOM, but the
        // extension hint names UTF-16 and the bytes genuinely are UTF-16
        // (non-ASCII content, so the #47 gate lets the hint through) —
        // the preview cut variant must match what `detect_with_extension`
        // (and therefore the real decode) actually chooses.
        let (le_bytes, _) = encode("中文", "UTF-16LE", false).unwrap();
        assert_eq!(
            preview_utf16_variant(&le_bytes, None, Some("UTF-16LE")),
            Some(Utf16Variant::Le)
        );
        let (be_bytes, _) = encode("中文", "UTF-16BE", false).unwrap();
        assert_eq!(
            preview_utf16_variant(&be_bytes, None, Some("UTF-16BE")),
            Some(Utf16Variant::Be)
        );
    }

    #[test]
    fn preview_utf16_variant_ext_hint_does_not_hijack_valid_utf8() {
        // #47 guard consistency: an ASCII sample and a genuine
        // non-ASCII-but-valid-UTF-8 sample must not be treated as UTF-16
        // here either, matching `detect_with_extension`'s rejection of
        // the same hint over the same bytes exactly — `preview_utf16_
        // variant` calls that guarded function directly, so it cannot
        // disagree with the real decode.
        let ascii = b"ab\ncd\n";
        assert!(ascii.is_ascii());
        assert_eq!(preview_utf16_variant(ascii, None, Some("UTF-16LE")), None);
        assert_eq!(preview_utf16_variant(ascii, None, Some("UTF-16BE")), None);

        let utf8_multibyte = "中文".as_bytes();
        assert_eq!(
            preview_utf16_variant(utf8_multibyte, None, Some("UTF-16LE")),
            None
        );
    }

    #[test]
    fn preview_utf16_variant_no_hint_no_bom_utf8_is_none() {
        // No explicit label, no ext hint, no BOM: nothing but the
        // (absent) BOM to go on, same as plain `utf16_variant`.
        assert_eq!(
            preview_utf16_variant(b"plain ascii, no hint at all", None, None),
            None
        );
    }

    #[test]
    fn preview_utf16_variant_ext_hint_bom_still_wins() {
        // A BOM present alongside a conflicting ext hint: the BOM wins,
        // matching `detect_with_extension` rule 1 (and the existing
        // `utf16_ext_hint_bom_still_wins` guarantee) exactly.
        let (bytes, _) = encode("hi", "UTF-16LE", true).unwrap();
        assert_eq!(
            preview_utf16_variant(&bytes, None, Some("UTF-16BE")),
            Some(Utf16Variant::Le)
        );
    }

    /// `lib.rs::open_document`'s bounded large-file read can end in one
    /// extra sentinel byte beyond the preview window (see its doc
    /// comment) — an odd-length sample always reports a dangling code
    /// unit as malformed, which would reject a genuine UTF-16 ext hint
    /// for the very reason this function exists. A trailing odd byte
    /// must not change the verdict versus the same content without it.
    #[test]
    fn preview_utf16_variant_trims_odd_length_sentinel_byte() {
        let (mut bytes, _) = encode("中文\n", "UTF-16LE", false).unwrap();
        let without_sentinel = preview_utf16_variant(&bytes, None, Some("UTF-16LE"));
        bytes.push(0xAB); // arbitrary sentinel byte, now odd-length
        let with_sentinel = preview_utf16_variant(&bytes, None, Some("UTF-16LE"));
        assert_eq!(without_sentinel, Some(Utf16Variant::Le));
        assert_eq!(with_sentinel, Some(Utf16Variant::Le));
    }

    // --- Issue #71 P1/P3: truncation-tolerant detection so a large valid
    // UTF-8 file whose preview window splits a character is not mis-read
    // as UTF-16 via an extension hint ---

    #[test]
    fn trim_truncated_utf8_tail_drops_only_a_truncated_final_sequence() {
        // "中" is E4 B8 AD; drop its final byte so the sample ends in a
        // 2-of-3-byte truncated sequence. from_utf8's error_len() is None
        // ("unexpected end"), so the tail is trimmed to the last complete
        // character.
        let full = "ab中".as_bytes(); // 61 62 E4 B8 AD
        let cut = &full[..full.len() - 1]; // 61 62 E4 B8
        let err = std::str::from_utf8(cut).unwrap_err();
        assert!(err.error_len().is_none(), "must be an end-of-input error");
        assert_eq!(trim_truncated_utf8_tail(cut), b"ab");
    }

    #[test]
    fn trim_truncated_utf8_tail_keeps_valid_and_ascii_and_empty_unchanged() {
        assert_eq!(
            trim_truncated_utf8_tail("ab中".as_bytes()),
            "ab中".as_bytes()
        );
        assert_eq!(trim_truncated_utf8_tail(b"plain ascii"), b"plain ascii");
        assert_eq!(trim_truncated_utf8_tail(b""), b"");
    }

    #[test]
    fn trim_truncated_utf8_tail_keeps_interior_invalid_unchanged() {
        // Genuine BOM-less UTF-16 of non-ASCII text has an invalid byte in
        // the *interior* (error_len() == Some) within its first code
        // units, so it must be left untouched for the UTF-16 hint to still
        // resolve. Here 87 (a continuation byte where a lead is expected)
        // is invalid at index 2 — near this short sample's end, which is
        // exactly why error_len(), not a distance heuristic, is the right
        // discriminator.
        let (le_bytes, _) = encode("中文", "UTF-16LE", false).unwrap();
        let err = std::str::from_utf8(&le_bytes).unwrap_err();
        assert!(
            err.error_len().is_some(),
            "fixture must have an interior invalid byte"
        );
        assert_eq!(trim_truncated_utf8_tail(&le_bytes), &le_bytes[..]);
    }

    // --- Issue #118: the leading-edge mirror, for large-file chunk paging
    // continuing mid-character after a previous chunk's raw byte cut. ---

    #[test]
    fn trim_truncated_utf8_head_drops_only_orphaned_continuation_bytes() {
        // "中" is E4 B8 AD; a chunk starting after the lead byte was
        // consumed by the previous one begins with 1 or 2 orphaned
        // continuation bytes (B8, or B8 AD), then resumes clean content.
        let one_orphan = [&[0xB8][..], "ab".as_bytes()].concat();
        assert_eq!(trim_truncated_utf8_head(&one_orphan), b"ab");
        let two_orphans = [&[0xB8, 0xAD][..], "ab".as_bytes()].concat();
        assert_eq!(trim_truncated_utf8_head(&two_orphans), b"ab");
    }

    #[test]
    fn trim_truncated_utf8_head_keeps_ascii_and_empty_unchanged() {
        assert_eq!(trim_truncated_utf8_head(b"plain ascii"), b"plain ascii");
        assert_eq!(
            trim_truncated_utf8_head("中文".as_bytes()),
            "中文".as_bytes()
        );
        assert_eq!(trim_truncated_utf8_head(b""), b"");
    }

    #[test]
    fn trim_truncated_utf8_head_stops_after_at_most_three_continuation_bytes() {
        // A 4-byte sequence's lead byte is followed by 3 continuation
        // bytes at most — a 4th 0x80-0xBF byte is never part of the same
        // orphaned sequence and must be left for the caller/decoder to
        // report on its own terms.
        let four = [0x80, 0x81, 0x82, 0x83];
        assert_eq!(trim_truncated_utf8_head(&four), &[0x83]);
    }

    // --- Issue #165: the #136 UTF-8 fix's sibling for an explicit reopen
    // as one of the legacy multi-byte encodings (Big5, Shift_JIS, GBK,
    // gb18030, EUC-JP, EUC-KR) ---

    #[test]
    fn is_legacy_multibyte_label_true_for_legacy_false_for_others() {
        for label in ["Big5", "Shift_JIS", "GBK", "gb18030", "EUC-JP", "EUC-KR"] {
            assert!(
                is_legacy_multibyte_label(label),
                "{label} must be recognized as a legacy multi-byte encoding"
            );
        }
        for label in [
            "UTF-8",
            "UTF-16LE",
            "UTF-16BE",
            "windows-1252",
            "ISO-2022-JP",
            "not-a-real-label",
        ] {
            assert!(
                !is_legacy_multibyte_label(label),
                "{label} must NOT be treated as a legacy multi-byte encoding \
                 (single-byte encodings and UTF-8/16 have their own dedicated \
                 gates, ISO-2022-JP's decoder is stateful, and an unknown \
                 label never resolves to anything)"
            );
        }
    }

    #[test]
    fn trim_truncated_legacy_tail_big5_drops_only_truncated_final_sequence() {
        // "測" and "試" are each 2-byte Big5 characters; cut the sample's
        // last byte off so it ends in a 1-of-2-byte truncated sequence.
        let (full, unmappable) = encode("ab測試", "Big5", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in Big5"
        );
        let cut = &full[..full.len() - 1];
        assert_eq!(
            trim_truncated_legacy_tail(cut, "Big5"),
            &full[..full.len() - 2],
            "must drop the whole truncated final character, keeping only \
             the complete characters before it"
        );
    }

    #[test]
    fn trim_truncated_legacy_tail_keeps_valid_and_ascii_and_empty_unchanged() {
        let (full, unmappable) = encode("ab測試", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(trim_truncated_legacy_tail(&full, "Big5"), &full[..]);
        assert_eq!(
            trim_truncated_legacy_tail(b"plain ascii", "Big5"),
            b"plain ascii"
        );
        assert_eq!(trim_truncated_legacy_tail(b"", "Big5"), b"");
    }

    #[test]
    fn trim_truncated_legacy_tail_keeps_interior_invalid_unchanged() {
        // 0xFF is never a valid Big5 lead byte; placed well before the
        // end, with an otherwise-clean tail. No cut depth can remove an
        // *interior* error by trimming only the tail, so this must come
        // back unchanged and surface as malformed via the real decode
        // instead -- #136's interior-malformed principle, carried over to
        // Big5.
        let (mut full, unmappable) = encode("ab測試", "Big5", false).unwrap();
        assert!(!unmappable);
        full[1] = 0xFF; // inside "ab", nowhere near the tail
        assert_eq!(trim_truncated_legacy_tail(&full, "Big5"), &full[..]);
    }

    #[test]
    fn trim_truncated_legacy_tail_gb18030_drops_truncated_four_byte_tail_at_each_split_position() {
        // U+20000 is outside the BMP, so gb18030 always encodes it with
        // its four-byte supplementary-plane form -- a fixed linear
        // mapping, unlike the BMP's compatibility ranges -- making this
        // the one case among the six supported encodings whose longest
        // sequence is 4 bytes rather than 2 or 3 (see
        // `max_legacy_seq_len`).
        let (full, unmappable) = encode("a\u{20000}b", "gb18030", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in gb18030"
        );
        assert_eq!(full.len(), 6, "1 (a) + 4 (U+20000) + 1 (b) bytes");
        let complete_prefix = &full[..1]; // just "a"
        for visible in 1..=3 {
            let cut = &full[..1 + visible];
            assert_eq!(
                trim_truncated_legacy_tail(cut, "gb18030"),
                complete_prefix,
                "{visible}-of-4 visible bytes of the truncated character must \
                 all be dropped, keeping only the complete prefix"
            );
        }
    }

    #[test]
    fn trim_truncated_legacy_tail_unknown_or_non_legacy_label_is_noop() {
        let (full, unmappable) = encode("ab測試", "Big5", false).unwrap();
        assert!(!unmappable);
        let cut = &full[..full.len() - 1];
        // A label this function doesn't own -- UTF-8, a single-byte
        // encoding, or one this crate has never heard of -- must never be
        // trimmed; `open_document`'s gate is expected to have already
        // resolved which trim function (if any) applies before ever
        // calling this one.
        assert_eq!(trim_truncated_legacy_tail(cut, "UTF-8"), cut);
        assert_eq!(trim_truncated_legacy_tail(cut, "windows-1252"), cut);
        assert_eq!(trim_truncated_legacy_tail(cut, "not-a-real-label"), cut);
    }

    #[test]
    fn preview_utf16_variant_truncated_utf8_cjk_not_hijacked_by_hint() {
        // The P1 regression at the unit level: a valid-UTF-8 CJK sample
        // whose tail is truncated mid-character (as the 2 MiB preview
        // bound does) must NOT be probed as UTF-16 just because from_utf8
        // fails at that truncated tail. Before the truncation-tolerance
        // fix this returned Some(Le)/Some(Be) — the silent-mojibake hole
        // #47 closes for small files, reopened for large ones.
        let mut bytes = "中".repeat(1000).into_bytes();
        bytes.truncate(bytes.len() - 1); // cut the final "中" mid-sequence
        assert!(
            std::str::from_utf8(&bytes).is_err(),
            "tail must be truncated mid-character"
        );
        assert_eq!(preview_utf16_variant(&bytes, None, Some("UTF-16LE")), None);
        assert_eq!(preview_utf16_variant(&bytes, None, Some("UTF-16BE")), None);
    }

    // --- Issue #96: legacy multi-byte encodings are not injective -------
    //
    // These are *characterization* tests, not bug reports: they pin
    // `encoding_rs` 0.8.35's actual, current canonicalizing behavior for
    // three known non-injective byte sequences (verified directly against
    // the version this workspace's `Cargo.lock` locks), so that a future
    // `encoding_rs` upgrade that silently changes this behavior fails a
    // test instead of drifting unnoticed. They deliberately do NOT assert
    // `encode(decode(bytes)) == bytes` — that equality is exactly what
    // does not hold here. See the module doc's "Round-trip contract"
    // section and issue #96 for what this project does and does not
    // guarantee.

    #[test]
    fn big5_non_canonical_bytes_are_canonicalized_on_encode() {
        // 0x8E 0x69 is a duplicate Big5 mapping for "箸" (U+7BB8): it
        // decodes cleanly (no malformed sequence), but `encode` always
        // emits that character's canonical byte pair, 0xBA 0xE6 — not the
        // original bytes.
        let original = [0x8Eu8, 0x69];
        let (text, malformed) = encoding_rs::BIG5.decode_without_bom_handling(&original);
        assert!(!malformed, "0x8E 0x69 must decode cleanly as Big5");
        assert_eq!(text, "箸");

        let (canonical, unmappable) = encode(&text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert_ne!(
            canonical.as_slice(),
            &original[..],
            "characterizes current canonicalizing behavior: encode(decode(bytes)) \
             != bytes for this non-injective Big5 mapping, even though decoding \
             was clean and nothing was unmappable"
        );
        assert_eq!(canonical, vec![0xBA, 0xE6]);
    }

    #[test]
    fn shift_jis_non_canonical_bytes_are_canonicalized_on_encode() {
        // 0x87 0x90 is a duplicate Shift_JIS mapping for "≒" (U+2252): it
        // decodes cleanly, but `encode` always emits the canonical pair
        // 0x81 0xE0 — not the original bytes.
        let original = [0x87u8, 0x90];
        let (text, malformed) = encoding_rs::SHIFT_JIS.decode_without_bom_handling(&original);
        assert!(!malformed, "0x87 0x90 must decode cleanly as Shift_JIS");
        assert_eq!(text, "≒");

        let (canonical, unmappable) = encode(&text, "Shift_JIS", false).unwrap();
        assert!(!unmappable);
        assert_ne!(
            canonical.as_slice(),
            &original[..],
            "characterizes current canonicalizing behavior: encode(decode(bytes)) \
             != bytes for this non-injective Shift_JIS mapping, even though \
             decoding was clean and nothing was unmappable"
        );
        assert_eq!(canonical, vec![0x81, 0xE0]);
    }

    #[test]
    fn gbk_non_canonical_bytes_are_canonicalized_on_encode() {
        // 0xA2 0xE3 is a duplicate GBK mapping for "€" (U+20AC): it
        // decodes cleanly, but `encode` always emits the single-byte
        // vendor-extension canonical form, 0x80 — not the original two
        // bytes.
        let original = [0xA2u8, 0xE3];
        let (text, malformed) = encoding_rs::GBK.decode_without_bom_handling(&original);
        assert!(!malformed, "0xA2 0xE3 must decode cleanly as GBK");
        assert_eq!(text, "€");

        let (canonical, unmappable) = encode(&text, "GBK", false).unwrap();
        assert!(!unmappable);
        assert_ne!(
            canonical.as_slice(),
            &original[..],
            "characterizes current canonicalizing behavior: encode(decode(bytes)) \
             != bytes for this non-injective GBK mapping, even though decoding \
             was clean and nothing was unmappable"
        );
        assert_eq!(canonical, vec![0x80]);
    }
}
