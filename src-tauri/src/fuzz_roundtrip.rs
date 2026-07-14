//! Deterministic-PRNG fuzz expansion for the encoding round-trip contract
//! (ROADMAP v0.4 Track D), scheduled before the Track A content-transform
//! work (full-width/half-width, normalization) lands on top of the
//! encoding layer.
//!
//! ## Survey before writing this
//!
//! The task brief that scheduled this expected `streamreplace.rs` to
//! already have a fuzz precedent (a "2M fuzz" using a hand-rolled
//! xorshift/LCG PRNG) to reuse. It does not: `streamreplace.rs`'s large
//! tests (`replaces_across_whole_large_utf8_file`,
//! `replaces_in_big5_file_preserving_encoding`) are fixed-size,
//! non-randomized stress fixtures (an 11 MiB planted-marker file, a
//! `filler_unit.repeat(5_600_000)` Big5 buffer) -- large, but
//! deterministic in the ordinary sense of "no randomness involved", not
//! PRNG-driven. A repo-wide search for `fuzz`/`xorshift`/`lcg`/`prng`/
//! `rand` across `src-tauri/src` and `src` turned up nothing. This file is
//! therefore the first randomized fuzz harness in the crate; `XorShift64`
//! below was picked fresh (see its doc comment) rather than reused from
//! anywhere.
//!
//! `encoding.rs` had exactly two tests literally named `round_trips_*`
//! (`round_trips_big5`, `round_trips_utf16le_with_bom`, plus
//! `round_trips_big5_via_extension_preference`, which exercises the same
//! Big5 case through a different entry point) before this file: Big5 and
//! UTF-16LE, both single fixed short strings ("中文" / "hi"). No encoding
//! round-trip test existed at all for plain UTF-8, UTF-16BE, GBK,
//! gb18030, Shift_JIS, EUC-JP, EUC-KR, or windows-1252 -- this file adds
//! deterministic-PRNG coverage across all ten.
//!
//! ## What this fuzzes (and what it deliberately does not)
//!
//! Issue #109 (see `encoding.rs`'s module doc, "Round-trip contract")
//! documents precisely what this project promises on a decode -> encode
//! cycle: the decoded *text*, the *encoding label*, the *BOM flag*, and
//! the *line ending* survive; **byte-for-byte identity of the re-encoded
//! output is not guaranteed** for a handful of non-injective legacy
//! multi-byte mappings (three are pinned as characterization tests at the
//! bottom of `encoding.rs`). This file fuzzes exactly the guaranteed
//! layer -- `text -> apply_line_ending -> encode -> decode -> normalize_to_lf
//! -> text` -- the same pipeline `save_document`/`open_document` run, and
//! never asserts anything about the intermediate bytes beyond "encode
//! reported nothing unmappable" / "decode reported nothing malformed". It
//! is not a byte-level fuzz and is not expected to (and must not) trip the
//! #109 gap: that gap only bites when the *input bytes* are already a
//! non-canonical legacy sequence, and every byte sequence here is
//! `encoding_rs`-emitted, which is always canonical by construction.
//!
//! ## Representable-text pools
//!
//! Two families:
//!
//! - **Universal** (UTF-8, UTF-16LE, UTF-16BE): every non-surrogate
//!   Unicode scalar value is representable, so generation samples the
//!   full scalar range directly (`random_universal_scalar`) plus a
//!   curated edge-case set (`universal_edge_scalars`: C0/C1 controls,
//!   NUL, DEL, U+FEFF, U+FFFD, and a spread of astral-plane characters
//!   that force UTF-16 surrogate pairs) mixed in at a fixed rate -- no
//!   encode-filter needed, since `encoding_rs` treats UTF-8/UTF-16 as
//!   total, injective transformation formats over that domain.
//! - **Filtered** (Big5, GBK, gb18030, Shift_JIS, EUC-JP, EUC-KR,
//!   windows-1252): a plausible candidate Unicode range for that script
//!   (e.g. CJK Unified Ideographs for the Chinese/Japanese legacy
//!   encodings, Hangul syllables for EUC-KR) is swept and filtered down
//!   to only the characters `encoding::encode` reports as mappable --
//!   the "encode-filter" method the task brief explicitly allows, so this
//!   file never has to hand-transcribe any encoding's mapping table.
//!   Critically, the encode-filter result is *not* trusted on its own:
//!   every pool has a dedicated sanity test (`*_pool_is_representable`)
//!   that independently proves `decode(encode(c)) == c` for every pooled
//!   character, one at a time -- the oracle the task brief requires to
//!   hold independently of the filter that built the pool.
//!
//! ## Mojibake wizard reversibility
//!
//! `mojibake::REPAIR_PAIRS` (made `pub(crate)` for this file to iterate
//! without duplicating it) lists the wizard's eight supported
//! `(intermediate, original)` mis-decode hypotheses. For each, this file
//! generates representable `original`-text, encodes it (the bytes a real
//! file would have had), mis-decodes those bytes with `intermediate`
//! (skipping -- not failing -- the rare random sample that doesn't decode
//! cleanly under `intermediate`, exactly as real mojibake requires a
//! clean mis-decode to occur at all), and asserts
//! `apply_mojibake_repair` recovers the original text exactly.

/// Minimal hand-rolled xorshift64 (Marsaglia 2003, public domain) PRNG.
/// No `rand` crate: ROADMAP's no-new-dependencies constraint, and (per
/// the module doc above) there was no existing PRNG in the crate to reuse
/// either. Deterministic and reproducible: the same seed and call
/// sequence always produce the same numbers, which is all a fuzz harness
/// needs -- this is not cryptographic randomness.
struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        // State 0 is a fixed point (stays 0 forever); nudge to a fixed
        // nonzero constant instead of ever silently generating zeros.
        Self(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// An index in `0..bound`. The small modulo bias this introduces is
    /// irrelevant at test-fuzzing scale (not cryptographic sampling).
    fn next_range(&mut self, bound: usize) -> usize {
        assert!(bound > 0, "next_range bound must be positive");
        (self.next_u64() % bound as u64) as usize
    }

    fn choose<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.next_range(items.len())]
    }
}

/// Single seed shared by every fuzz test in this file, so a failure is
/// reproducible by re-running `XorShift64::new(ROUNDTRIP_FUZZ_SEED)` --
/// each test creates its own independent generator from this same seed,
/// so tests never interfere with each other's sequences. Case counts are
/// documented per test (in the name and/or its doc comment).
const ROUNDTRIP_FUZZ_SEED: u64 = 0x5EED_C0FF_EE15_1234;

const LINE_ENDINGS: [&str; 3] = ["LF", "CRLF", "CR"];

/// Every encoding this app exposes to users (`src/encodings.ts`'s
/// `encodingChoices`, collapsing the UTF-8-with-BOM variant into plain
/// "UTF-8" since it's the same underlying `Encoding`).
const ALL_ENCODING_LABELS: [&str; 10] = [
    "UTF-8",
    "UTF-16LE",
    "UTF-16BE",
    "Big5",
    "gb18030",
    "GBK",
    "Shift_JIS",
    "EUC-JP",
    "EUC-KR",
    "windows-1252",
];

/// Only UTF-8/UTF-16LE/UTF-16BE have a BOM concept in `encoding::encode`
/// (the `with_bom` flag is a no-op for every legacy label -- see
/// `encoding::encode`'s body: the BOM branches are gated on `encoding ==
/// UTF_8` or UTF-16). Legacy labels get a single `false` state; asserting
/// `with_bom` did anything for them would just be re-testing that no-op.
fn bom_states_for(label: &str) -> &'static [bool] {
    match label {
        "UTF-8" | "UTF-16LE" | "UTF-16BE" => &[false, true],
        _ => &[false],
    }
}

// --- Candidate Unicode ranges for the filtered pools (inclusive) --------

const ASCII_NO_EOL: (u32, u32) = (0x00, 0x7F); // \n/\r stripped out below
const CJK_COMMON: (u32, u32) = (0x4E00, 0x9FFF); // CJK Unified Ideographs
const HIRAGANA: (u32, u32) = (0x3040, 0x309F);
const KATAKANA: (u32, u32) = (0x30A0, 0x30FF);
const HANGUL_SYLLABLES: (u32, u32) = (0xAC00, 0xD7A3);
const LATIN1_SUPPLEMENT: (u32, u32) = (0x00A0, 0x00FF);
const LATIN_EXTENDED_A: (u32, u32) = (0x0100, 0x017F);
const GENERAL_PUNCTUATION: (u32, u32) = (0x2000, 0x206F);
const CURRENCY_SYMBOLS: (u32, u32) = (0x20A0, 0x20CF);
const LETTERLIKE_SYMBOLS: (u32, u32) = (0x2100, 0x214F);

/// Ask `encoding::encode` itself whether `c` is representable in `label`
/// -- the "encode-filter" method, so no encoding's mapping table needs to
/// be hand-transcribed here.
fn is_representable(c: char, label: &str) -> bool {
    let mut buf = [0u8; 4];
    let s: &str = c.encode_utf8(&mut buf);
    matches!(crate::encoding::encode(s, label, false), Ok((_, false)))
}

/// Sweep `ranges` and keep only the characters `label` can encode. `\n`
/// and `\r` are always excluded -- line endings are a separate, orthogonal
/// fuzz axis (`LINE_ENDINGS`, applied via `apply_line_ending`), and a raw
/// `\r` surviving inside generated *content* would break the round-trip
/// assertion for a harness reason, not a product one (`normalize_to_lf`
/// only runs on the decoded side, so a stray `\r` planted directly in
/// `content` is not idempotent across the pipeline).
fn build_filtered_pool(label: &str, ranges: &[(u32, u32)]) -> Vec<char> {
    ranges
        .iter()
        .flat_map(|&(start, end)| start..=end)
        .filter_map(char::from_u32)
        .filter(|&c| c != '\n' && c != '\r')
        .filter(|&c| is_representable(c, label))
        .collect()
}

fn big5_pool() -> Vec<char> {
    build_filtered_pool("Big5", &[ASCII_NO_EOL, CJK_COMMON])
}

fn gbk_pool() -> Vec<char> {
    build_filtered_pool("GBK", &[ASCII_NO_EOL, CJK_COMMON])
}

fn gb18030_pool() -> Vec<char> {
    build_filtered_pool("gb18030", &[ASCII_NO_EOL, CJK_COMMON])
}

fn shift_jis_pool() -> Vec<char> {
    build_filtered_pool("Shift_JIS", &[ASCII_NO_EOL, HIRAGANA, KATAKANA, CJK_COMMON])
}

fn euc_jp_pool() -> Vec<char> {
    build_filtered_pool("EUC-JP", &[ASCII_NO_EOL, HIRAGANA, KATAKANA, CJK_COMMON])
}

fn euc_kr_pool() -> Vec<char> {
    build_filtered_pool("EUC-KR", &[ASCII_NO_EOL, HANGUL_SYLLABLES])
}

fn windows1252_pool() -> Vec<char> {
    build_filtered_pool(
        "windows-1252",
        &[
            ASCII_NO_EOL,
            LATIN1_SUPPLEMENT,
            LATIN_EXTENDED_A,
            GENERAL_PUNCTUATION,
            CURRENCY_SYMBOLS,
            LETTERLIKE_SYMBOLS,
        ],
    )
}

/// U+00E1..=U+00FF: every codepoint here is exactly 2 UTF-8 bytes `C3 xx`
/// with `xx` in `A1..=BF`. That is simultaneously a valid Big5/GBK
/// lead+trail byte pair (both span lead `81..=FE`), *and* -- because
/// Shift_JIS's lead-byte ranges (`81..=9F`, `E0..=FC`) leave `A0..=DF` as
/// single-byte half-width katakana, and `C3`/`A1..=BF` both fall in that
/// span -- a clean (if differently-shaped) Shift_JIS decode too. Mirrors
/// `mojibake.rs`'s own `LATIN1_SUPPLEMENT_TEXT` fixture and its doc
/// comment; used here so the (Big5/GBK/Shift_JIS, UTF-8) reversibility
/// cases have a high clean-mis-decode hit rate instead of relying on
/// fully random UTF-8 text, which essentially never lines up with any of
/// these three encodings' byte structure by chance.
fn latin1_supplement_lower_accented_pool() -> Vec<char> {
    build_filtered_pool("UTF-8", &[(0x00E1, 0x00FF)])
}

/// Curated edge cases always mixed into universal (UTF-8/UTF-16) text:
/// C0/C1 controls, NUL, DEL, the BOM/ZWNBSP character U+FEFF, the
/// replacement character U+FFFD, and a spread of astral-plane (>U+FFFF)
/// characters that force UTF-16 surrogate-pair encoding.
fn universal_edge_scalars() -> Vec<char> {
    let mut v: Vec<char> = (0x00u32..=0x1Fu32)
        .filter(|&cp| cp != 0x0A && cp != 0x0D)
        .filter_map(char::from_u32)
        .collect();
    v.push('\u{7F}'); // DEL
    v.extend((0x80u32..=0x9Fu32).filter_map(char::from_u32)); // C1 controls
    v.push('\u{FEFF}'); // ZWNBSP / BOM character, as ordinary content
    v.push('\u{FFFD}'); // REPLACEMENT CHARACTER
    v.extend(
        [
            0x1_0000u32, // first Supplementary Multilingual Plane cp
            0x1_F600,    // emoji: GRINNING FACE
            0x1_F9E1,    // emoji: ORANGE HEART
            0x2_0000,    // first Supplementary Ideographic Plane cp
            0x2_F800,    // CJK Compatibility Ideographs Supplement
            0xE_0001,    // language tag (Supplementary Special-purpose Plane)
            0x10_FFFD,   // last Private Use Area-B codepoint
            0x10_FFFF,   // last valid Unicode scalar value
        ]
        .into_iter()
        .filter_map(char::from_u32),
    );
    v
}

/// A uniformly random non-surrogate Unicode scalar value (retries on the
/// rare draw that lands in the D800..=DFFF surrogate gap, which
/// `char::from_u32` rejects), excluding `\n`/`\r` for the same reason
/// `build_filtered_pool` excludes them.
fn random_universal_scalar(rng: &mut XorShift64) -> char {
    loop {
        let cp = (rng.next_u64() % 0x11_0000u64) as u32;
        if let Some(c) = char::from_u32(cp) {
            if c != '\n' && c != '\r' {
                return c;
            }
        }
    }
}

fn random_text_from_pool(rng: &mut XorShift64, pool: &[char], len: usize) -> String {
    assert!(!pool.is_empty(), "representable pool must not be empty");
    (0..len).map(|_| *rng.choose(pool)).collect()
}

/// 1-in-5 chance per character of drawing from `edge` (guaranteeing edge
/// cases show up often, not just at their natural low probability),
/// otherwise a fully random scalar.
fn random_text_from_universal(rng: &mut XorShift64, edge: &[char], len: usize) -> String {
    (0..len)
        .map(|_| {
            if !edge.is_empty() && rng.next_range(5) == 0 {
                *rng.choose(edge)
            } else {
                random_universal_scalar(rng)
            }
        })
        .collect()
}

fn random_multiline_from_pool(
    rng: &mut XorShift64,
    pool: &[char],
    num_lines: usize,
    max_line_len: usize,
) -> String {
    (0..num_lines)
        .map(|_| {
            let len = rng.next_range(max_line_len) + 1;
            random_text_from_pool(rng, pool, len)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn random_multiline_universal(
    rng: &mut XorShift64,
    edge: &[char],
    num_lines: usize,
    max_line_len: usize,
) -> String {
    let mut content = (0..num_lines)
        .map(|_| {
            let len = rng.next_range(max_line_len) + 1;
            random_text_from_universal(rng, edge, len)
        })
        .collect::<Vec<_>>()
        .join("\n");
    // A leading U+FEFF is byte-for-byte indistinguishable, once encoded,
    // from a real prepended BOM -- `Encoding::for_bom` (like every other
    // BOM-sniffing decoder) cannot tell "content that happens to start
    // with a literal ZWNBSP" from "a real encoding-detection BOM". This is
    // a fundamental, industry-wide ambiguity in the BOM mechanism itself,
    // not a bug: the app's own very first decode of a real file already
    // strips a leading U+FEFF the same way, so a document's in-memory
    // `content` can never actually reach this state in practice. Re-roll
    // just the first character so the fuzz doesn't manufacture a false
    // positive out of a state the app can never really be in.
    if content.starts_with('\u{FEFF}') {
        content.replace_range(.."\u{FEFF}".len(), "A");
    }
    content
}

enum TextSource<'a> {
    Pool(&'a [char]),
    /// Full-Unicode-scalar sampling plus a curated edge-case set, for the
    /// three encodings with no encode-filter gap (UTF-8/UTF-16LE/UTF-16BE).
    Universal(&'a [char]),
}

fn random_multiline(
    rng: &mut XorShift64,
    source: &TextSource,
    num_lines: usize,
    max_line_len: usize,
) -> String {
    match source {
        TextSource::Pool(pool) => random_multiline_from_pool(rng, pool, num_lines, max_line_len),
        TextSource::Universal(edge) => {
            random_multiline_universal(rng, edge, num_lines, max_line_len)
        }
    }
}

/// Runs the same pipeline `save_document`/`open_document` do (see
/// `encoding.rs`'s "Round-trip contract" doc): apply the requested line
/// ending, encode, decode with that same explicit label, normalize back
/// to LF, and assert every part of the contract -- text, encoding label,
/// BOM flag -- survived. Deliberately does not assert anything about the
/// re-encoded bytes beyond "nothing unmappable / malformed": byte-for-byte
/// identity is exactly the guarantee issue #109 documents this project
/// does *not* make (see this file's module doc).
fn assert_round_trips(label: &str, with_bom: bool, line_ending: &str, content: &str) {
    let text = crate::encoding::apply_line_ending(content, line_ending);
    let (bytes, unmappable) = crate::encoding::encode(&text, label, with_bom)
        .unwrap_or_else(|e| panic!("encode({label}) failed: {e}\ntext: {text:?}"));
    assert!(
        !unmappable,
        "unexpected unmappable character encoding representable text as {label}\ntext: {text:?}"
    );
    let decoded = crate::encoding::decode_with(&bytes, label)
        .unwrap_or_else(|e| panic!("decode_with({label}) failed: {e}"));
    assert!(
        !decoded.malformed,
        "decode reported malformed data for {label} (bom={with_bom}, line_ending={line_ending})\n\
         text: {text:?}\nbytes: {bytes:?}"
    );
    assert_eq!(
        decoded.encoding, label,
        "decoded encoding label drifted for {label}"
    );
    let round_tripped = crate::encoding::normalize_to_lf(&decoded.content);
    assert_eq!(
        round_tripped, content,
        "round-trip text mismatch (encoding={label}, bom={with_bom}, line_ending={line_ending})\n\
         original:  {content:?}\nrecovered: {round_tripped:?}"
    );
    if matches!(label, "UTF-8" | "UTF-16LE" | "UTF-16BE") {
        assert_eq!(
            decoded.had_bom, with_bom,
            "BOM flag did not round-trip for {label} (requested with_bom={with_bom})"
        );
    }
}

fn run_round_trip_fuzz(label: &str, cases: usize, rng: &mut XorShift64, source: &TextSource) {
    for &line_ending in &LINE_ENDINGS {
        for &with_bom in bom_states_for(label) {
            for _ in 0..cases {
                let num_lines = rng.next_range(5) + 1;
                let content = random_multiline(rng, source, num_lines, 24);
                assert_round_trips(label, with_bom, line_ending, &content);
            }
        }
    }
}

// --- Pool sanity tests ---------------------------------------------------
//
// Each generator gets its own test proving its output is truly
// representable *before* it is trusted as a fuzz source: pool size must
// clear a sane floor (catching "the filter ate everything"), and every
// pooled character must independently round-trip through
// `encoding::encode` -> `encoding::decode_with` -- the oracle the encode-
// filter itself is not allowed to just assert about its own output.

fn assert_pool_is_representable(label: &str, pool: &[char], min_size: usize) {
    assert!(
        pool.len() >= min_size,
        "{label} representable pool unexpectedly small: {} chars (expected >= {min_size})",
        pool.len()
    );
    for &c in pool {
        let mut buf = [0u8; 4];
        let s: &str = c.encode_utf8(&mut buf);
        let (bytes, unmappable) = crate::encoding::encode(s, label, false)
            .unwrap_or_else(|e| panic!("encode failed for U+{:04X} in {label}: {e}", c as u32));
        assert!(
            !unmappable,
            "U+{:04X} unexpectedly unmappable in {label}",
            c as u32
        );
        let decoded = crate::encoding::decode_with(&bytes, label)
            .unwrap_or_else(|e| panic!("decode failed for U+{:04X} in {label}: {e}", c as u32));
        assert!(
            !decoded.malformed,
            "decode reported malformed for U+{:04X} in {label}",
            c as u32
        );
        assert_eq!(
            decoded.content, s,
            "U+{:04X} did not round-trip through {label}",
            c as u32
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big5_pool_is_representable() {
        assert_pool_is_representable("Big5", &big5_pool(), 500);
    }

    #[test]
    fn gbk_pool_is_representable() {
        assert_pool_is_representable("GBK", &gbk_pool(), 500);
    }

    #[test]
    fn gb18030_pool_is_representable() {
        assert_pool_is_representable("gb18030", &gb18030_pool(), 500);
    }

    #[test]
    fn shift_jis_pool_is_representable() {
        assert_pool_is_representable("Shift_JIS", &shift_jis_pool(), 500);
    }

    #[test]
    fn euc_jp_pool_is_representable() {
        assert_pool_is_representable("EUC-JP", &euc_jp_pool(), 500);
    }

    #[test]
    fn euc_kr_pool_is_representable() {
        assert_pool_is_representable("EUC-KR", &euc_kr_pool(), 500);
    }

    #[test]
    fn windows1252_pool_is_representable() {
        assert_pool_is_representable("windows-1252", &windows1252_pool(), 30);
    }

    #[test]
    fn latin1_supplement_lower_accented_pool_is_representable() {
        // This pool intentionally exists to be re-decoded under a
        // *different* encoding (Big5/GBK/Shift_JIS) elsewhere -- but on
        // its own terms, as UTF-8 text, it must still round-trip.
        // The candidate range (U+00E1..=U+00FF) is only 31 codepoints
        // wide, and every one of them is plain UTF-8-representable
        // (trivially, since UTF-8 covers all of Unicode) -- so the pool
        // should come back at exactly 31, not the ~500-scale floor the
        // CJK/Hangul pools use.
        assert_pool_is_representable("UTF-8", &latin1_supplement_lower_accented_pool(), 25);
    }

    #[test]
    fn universal_edge_scalars_are_representable() {
        // UTF-8 stands in for all three "universal" targets here: per the
        // module doc, `encoding_rs` treats UTF-8/UTF-16LE/UTF-16BE as
        // total, injective transformation formats over every non-surrogate
        // scalar value, so there is nothing UTF-8 accepts that UTF-16
        // wouldn't (and vice versa) -- checked directly for all three
        // below anyway, since it costs nothing at this scale.
        let edge = universal_edge_scalars();
        assert!(edge.len() >= 10, "expected a nontrivial edge-case set");
        for &c in &edge {
            let mut buf = [0u8; 4];
            let s: &str = c.encode_utf8(&mut buf);
            // U+FEFF as the sole (hence leading) character of an encoded
            // byte stream is byte-for-byte indistinguishable from a real
            // prepended BOM -- `decode_with`'s BOM-sniffing would strip
            // it, exactly the same inherent, industry-wide ambiguity
            // `random_multiline_universal`'s doc comment explains (and
            // works around by never generating it in leading position).
            // Prefix it with a harmless ASCII character here instead, so
            // this test proves the realistic claim: U+FEFF survives fine
            // as an ordinary *non-leading* character.
            let probe: String = if c == '\u{FEFF}' {
                format!("A{s}")
            } else {
                s.to_string()
            };
            for label in ["UTF-8", "UTF-16LE", "UTF-16BE"] {
                let (bytes, unmappable) = crate::encoding::encode(&probe, label, false).unwrap();
                assert!(!unmappable, "U+{:04X} unmappable in {label}", c as u32);
                let decoded = crate::encoding::decode_with(&bytes, label).unwrap();
                assert!(
                    !decoded.malformed,
                    "U+{:04X} malformed via {label}",
                    c as u32
                );
                assert_eq!(
                    decoded.content, probe,
                    "U+{:04X} did not round-trip through {label}",
                    c as u32
                );
            }
        }
    }

    /// Explicit check for the "surrogate pair" case the task brief calls
    /// out by name: an astral-plane (>U+FFFF) character must encode as
    /// *two* UTF-16 code units (4 bytes), not silently drop or split.
    #[test]
    fn astral_characters_encode_as_utf16_surrogate_pairs() {
        for &cp in &[0x1_0000u32, 0x1_F600, 0x10_FFFF] {
            let c = char::from_u32(cp).unwrap();
            let s = c.to_string();
            for label in ["UTF-16LE", "UTF-16BE"] {
                let (bytes, unmappable) = crate::encoding::encode(&s, label, false).unwrap();
                assert!(!unmappable);
                assert_eq!(
                    bytes.len(),
                    4,
                    "U+{cp:04X} must encode as a surrogate pair (4 bytes) in {label}, got {} bytes",
                    bytes.len()
                );
                let decoded = crate::encoding::decode_with(&bytes, label).unwrap();
                assert!(!decoded.malformed);
                assert_eq!(decoded.content, s);
            }
        }
    }

    /// The "混行尾" (mixed line endings) case the generator brief calls
    /// out explicitly: build content whose *raw* endings mix CRLF, a lone
    /// CR, and LF before normalization (exercising `detect_line_ending`'s
    /// actual "Mixed" classification), confirm `normalize_to_lf` collapses
    /// it the same way regardless of which encoding will carry it, then
    /// run the usual per-encoding round trip on the normalized result.
    #[test]
    fn mixed_raw_line_endings_normalize_and_round_trip_per_encoding() {
        let raw = "alpha\r\nbeta\rgamma\ndelta\r\nepsilon";
        assert_eq!(crate::encoding::detect_line_ending(raw), "Mixed");
        let content = crate::encoding::normalize_to_lf(raw);
        assert_eq!(content, "alpha\nbeta\ngamma\ndelta\nepsilon");

        for &label in &ALL_ENCODING_LABELS {
            for &line_ending in &LINE_ENDINGS {
                for &with_bom in bom_states_for(label) {
                    assert_round_trips(label, with_bom, line_ending, &content);
                }
            }
        }
    }

    // --- Main round-trip fuzz: all supported encodings ------------------
    //
    // Seed = ROUNDTRIP_FUZZ_SEED for every test below. 60 representable-
    // text cases x 3 line endings x (2 BOM states for UTF-8/UTF-16, else
    // 1) per encoding.

    #[test]
    fn round_trip_fuzz_utf8_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let edge = universal_edge_scalars();
        run_round_trip_fuzz("UTF-8", 60, &mut rng, &TextSource::Universal(&edge));
    }

    #[test]
    fn round_trip_fuzz_utf16le_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let edge = universal_edge_scalars();
        run_round_trip_fuzz("UTF-16LE", 60, &mut rng, &TextSource::Universal(&edge));
    }

    #[test]
    fn round_trip_fuzz_utf16be_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let edge = universal_edge_scalars();
        run_round_trip_fuzz("UTF-16BE", 60, &mut rng, &TextSource::Universal(&edge));
    }

    #[test]
    fn round_trip_fuzz_big5_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = big5_pool();
        run_round_trip_fuzz("Big5", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_gbk_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = gbk_pool();
        run_round_trip_fuzz("GBK", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_gb18030_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = gb18030_pool();
        run_round_trip_fuzz("gb18030", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_shift_jis_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = shift_jis_pool();
        run_round_trip_fuzz("Shift_JIS", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_euc_jp_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = euc_jp_pool();
        run_round_trip_fuzz("EUC-JP", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_euc_kr_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = euc_kr_pool();
        run_round_trip_fuzz("EUC-KR", 60, &mut rng, &TextSource::Pool(&pool));
    }

    #[test]
    fn round_trip_fuzz_windows1252_60cases() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pool = windows1252_pool();
        run_round_trip_fuzz("windows-1252", 60, &mut rng, &TextSource::Pool(&pool));
    }

    /// Manual-only, larger-volume version of every `round_trip_fuzz_*_60cases`
    /// test above, run together: 3,000 cases per encoding instead of 60 (a
    /// 50x larger sample), still deterministic under the same seed. Not
    /// part of the default `cargo test` run (kept under the CI time
    /// budget) -- run explicitly with:
    /// `cargo test --release -- --ignored large_round_trip_fuzz`.
    #[test]
    #[ignore]
    fn large_round_trip_fuzz_3000cases_per_encoding() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let edge = universal_edge_scalars();
        let big5 = big5_pool();
        let gbk = gbk_pool();
        let gb18030 = gb18030_pool();
        let shift_jis = shift_jis_pool();
        let euc_jp = euc_jp_pool();
        let euc_kr = euc_kr_pool();
        let windows1252 = windows1252_pool();

        let jobs: [(&str, TextSource); 10] = [
            ("UTF-8", TextSource::Universal(&edge)),
            ("UTF-16LE", TextSource::Universal(&edge)),
            ("UTF-16BE", TextSource::Universal(&edge)),
            ("Big5", TextSource::Pool(&big5)),
            ("GBK", TextSource::Pool(&gbk)),
            ("gb18030", TextSource::Pool(&gb18030)),
            ("Shift_JIS", TextSource::Pool(&shift_jis)),
            ("EUC-JP", TextSource::Pool(&euc_jp)),
            ("EUC-KR", TextSource::Pool(&euc_kr)),
            ("windows-1252", TextSource::Pool(&windows1252)),
        ];
        for (label, source) in &jobs {
            run_round_trip_fuzz(label, 3000, &mut rng, source);
        }
    }

    // --- Mojibake wizard reversibility fuzz -----------------------------

    struct MojibakePools {
        big5: Vec<char>,
        gb18030: Vec<char>,
        shift_jis: Vec<char>,
        euc_kr: Vec<char>,
        latin1_supplement: Vec<char>,
    }

    impl MojibakePools {
        fn build() -> Self {
            Self {
                big5: big5_pool(),
                gb18030: gb18030_pool(),
                shift_jis: shift_jis_pool(),
                euc_kr: euc_kr_pool(),
                latin1_supplement: latin1_supplement_lower_accented_pool(),
            }
        }
    }

    /// For each `mojibake::REPAIR_PAIRS` hypothesis: generate
    /// representable `original`-text, encode it (the bytes a real file
    /// would have had), mis-decode those bytes with `intermediate`, and
    /// assert `apply_mojibake_repair` recovers the original text exactly.
    ///
    /// A random sample that doesn't decode cleanly under `intermediate`
    /// is skipped, not failed: real mojibake requires a *clean* mis-decode
    /// to occur in the first place (a byte sequence `intermediate` can't
    /// even parse could never have been silently mis-opened and re-saved
    /// as such), so an unclean draw refutes nothing about the wizard. The
    /// three `(Big5|GBK|Shift_JIS, UTF-8)` pairs draw from
    /// `latin1_supplement_lower_accented_pool` specifically because plain
    /// random UTF-8 text essentially never lines up with those encodings'
    /// byte structure by chance (see that pool's doc comment); the other
    /// five pairs (`windows-1252` as intermediate) have no such constraint
    /// since windows-1252 decodes every byte value.
    fn run_mojibake_reversibility_fuzz(
        rng: &mut XorShift64,
        cases_per_pair: usize,
        pools: &MojibakePools,
    ) {
        let edge = universal_edge_scalars();
        let mut checked = 0usize;
        let mut skipped = 0usize;

        for &(intermediate, original) in crate::mojibake::REPAIR_PAIRS.iter() {
            let intermediate_label = intermediate.name();
            let original_label = original.name();
            let source = match (intermediate_label, original_label) {
                ("windows-1252", "UTF-8") => TextSource::Universal(&edge),
                ("windows-1252", "Big5") => TextSource::Pool(&pools.big5),
                ("windows-1252", "gb18030") => TextSource::Pool(&pools.gb18030),
                ("windows-1252", "Shift_JIS") => TextSource::Pool(&pools.shift_jis),
                ("windows-1252", "EUC-KR") => TextSource::Pool(&pools.euc_kr),
                ("Big5", "UTF-8") | ("GBK", "UTF-8") | ("Shift_JIS", "UTF-8") => {
                    TextSource::Pool(&pools.latin1_supplement)
                }
                (i, o) => panic!(
                    "unhandled mojibake::REPAIR_PAIRS entry ({i}, {o}) -- add a text generator"
                ),
            };

            for _ in 0..cases_per_pair {
                let len = rng.next_range(30) + 5;
                let text = match &source {
                    TextSource::Pool(pool) => random_text_from_pool(rng, pool, len),
                    TextSource::Universal(edge) => random_text_from_universal(rng, edge, len),
                };

                let (real_bytes, unmappable) =
                    crate::encoding::encode(&text, original_label, false)
                        .unwrap_or_else(|e| panic!("encode({original_label}) failed: {e}"));
                assert!(
                    !unmappable,
                    "pool member unexpectedly unmappable in {original_label}: {text:?}"
                );

                let (mojibake, malformed) = intermediate.decode_without_bom_handling(&real_bytes);
                if malformed {
                    skipped += 1;
                    continue;
                }
                let mojibake = mojibake.into_owned();
                checked += 1;

                let repaired = crate::mojibake::apply_mojibake_repair(
                    mojibake.clone(),
                    intermediate_label.to_string(),
                    original_label.to_string(),
                )
                .unwrap_or_else(|e| {
                    panic!(
                        "apply_mojibake_repair could not reverse a clean mis-decode \
                         (intermediate={intermediate_label}, original={original_label}): {e}\n\
                         original: {text:?}\nmojibake: {mojibake:?}"
                    )
                });
                assert_eq!(
                    repaired, text,
                    "mojibake repair did not recover the original text \
                     (intermediate={intermediate_label}, original={original_label})\n\
                     original: {text:?}\nmojibake: {mojibake:?}\nrepaired: {repaired:?}"
                );
            }
        }

        assert!(
            checked > 0,
            "fuzz must exercise at least one clean mis-decode case (checked=0, skipped={skipped})"
        );
    }

    /// Seed = ROUNDTRIP_FUZZ_SEED. 40 cases per `mojibake::REPAIR_PAIRS`
    /// hypothesis (320 attempts total; see `run_mojibake_reversibility_fuzz`
    /// for why some attempts are expected to be skipped rather than
    /// checked).
    #[test]
    fn mojibake_repair_reversibility_fuzz_40cases_per_pair() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pools = MojibakePools::build();
        run_mojibake_reversibility_fuzz(&mut rng, 40, &pools);
    }

    /// Manual-only, larger-volume version: 3,000 cases per pair. Run
    /// explicitly with:
    /// `cargo test --release -- --ignored large_mojibake_repair_reversibility_fuzz`.
    #[test]
    #[ignore]
    fn large_mojibake_repair_reversibility_fuzz_3000cases_per_pair() {
        let mut rng = XorShift64::new(ROUNDTRIP_FUZZ_SEED);
        let pools = MojibakePools::build();
        run_mojibake_reversibility_fuzz(&mut rng, 3000, &pools);
    }
}
