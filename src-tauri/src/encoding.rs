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

/// Reason `Detection::chosen` was picked: a BOM was found, chardetng made a
/// statistical call, or there were no bytes to analyze (empty input).
pub const REASON_BOM: &str = "bom";
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
/// behind the detection `decode_auto` would use. Shared by `decode_auto`
/// (which only needs `chosen`) and the `explain_detection` diagnostics
/// command (which reports all of it), so both stay in lockstep by
/// construction.
pub fn detect(bytes: &[u8]) -> Detection {
    let guess = detector_guess(bytes);
    if let Some((encoding, _bom_len)) = Encoding::for_bom(bytes) {
        return Detection {
            bom: Some(encoding),
            detector_guess: guess,
            chosen: encoding,
            reason: REASON_BOM,
        };
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
pub fn decode_auto(bytes: &[u8]) -> DecodedText {
    let detection = detect(bytes);
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
}
