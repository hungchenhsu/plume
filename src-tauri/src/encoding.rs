//! Encoding detection, decoding and encoding for document I/O.
//!
//! Detection order: BOM sniffing first, then statistical detection via
//! chardetng. Decoded text is normalized to LF; the original line ending is
//! reported separately so it can be restored on save.

use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

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

fn encode_utf16(text: &str, big_endian: bool, with_bom: bool) -> Vec<u8> {
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

/// Classify the dominant line ending of raw decoded text.
pub fn detect_line_ending(text: &str) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut prev_cr = false;
    for byte in text.bytes() {
        match byte {
            b'\n' if prev_cr => crlf += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        prev_cr = byte == b'\r';
    }
    match (crlf, lf) {
        (0, _) => "LF",
        (_, 0) => "CRLF",
        _ => "Mixed",
    }
}

/// Normalize CRLF and lone CR to LF for the in-memory document.
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Apply the requested line ending to LF-normalized text before encoding.
pub fn apply_line_ending(text: &str, line_ending: &str) -> String {
    match line_ending {
        "CRLF" => text.replace('\n', "\r\n"),
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

    #[test]
    fn applies_crlf_on_save() {
        assert_eq!(apply_line_ending("a\nb", "CRLF"), "a\r\nb");
        assert_eq!(apply_line_ending("a\nb", "LF"), "a\nb");
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
}
