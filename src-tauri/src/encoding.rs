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

/// Decode bytes by sniffing a BOM first and falling back to chardetng.
pub fn decode_auto(bytes: &[u8]) -> DecodedText {
    if let Some((encoding, _bom_len)) = Encoding::for_bom(bytes) {
        let (content, malformed) = encoding.decode_with_bom_removal(bytes);
        return DecodedText {
            content: content.into_owned(),
            encoding: encoding.name().to_string(),
            had_bom: true,
            malformed,
        };
    }
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (content, malformed) = encoding.decode_without_bom_handling(bytes);
    DecodedText {
        content: content.into_owned(),
        encoding: encoding.name().to_string(),
        had_bom: false,
        malformed,
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
