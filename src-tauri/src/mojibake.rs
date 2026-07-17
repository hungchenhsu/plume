//! Mojibake repair: detect "bytes decoded with the wrong encoding, then
//! saved back to disk" round-trips and offer a previewed, reversible fix.
//!
//! The shape of the bug this repairs: a file's *real* bytes were originally
//! `original`-encoded text. Something (an editor, a script, a browser)
//! opened those bytes using the wrong encoding, `intermediate`, producing
//! garbled but still-valid-looking text -- mojibake -- and that garbled
//! text got saved, so the bytes on disk now really are `intermediate`'s
//! encoding of the mojibake. To undo it: take the mojibake text the user
//! sees and *encode* it with `intermediate` (this losslessly reconstructs
//! the original bytes, because that is exactly the byte sequence
//! `intermediate` decoded to produce this text in the first place), then
//! *decode* those bytes with `original` (the encoding they actually were
//! all along). Example: Big5 bytes opened as Windows-1252 and re-saved --
//! encoding the garbled text back to Windows-1252 recovers the original
//! Big5 bytes, and decoding those as Big5 recovers the real text.
//!
//! This module never touches disk and never emits a raw byte over IPC
//! (ARCHITECTURE.md's hard constraints): it operates purely on the
//! in-memory document string the frontend already holds, and always
//! returns decoded `String`s. The repaired text becomes an unsaved editor
//! change (undoable, not auto-saved) -- reversibility is the caller's
//! responsibility, this module only ever computes the candidate/result.

use chardetng::EncodingDetector;
use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GB18030, GBK, KOI8_R, SHIFT_JIS, UTF_8, WINDOWS_1251,
    WINDOWS_1252,
};
use serde::Serialize;

/// Candidate "wrong" encodings bytes may have been mis-decoded with.
///
/// `ISO-8859-1` is deliberately not listed here. In encoding_rs (which
/// implements the WHATWG Encoding Standard), every ISO-8859-1 label --
/// "iso-8859-1", "latin1", "l1", "iso_8859-1", "csisolatin1", ... -- is
/// verified (against encoding_rs 0.8.35's own `LABELS_SORTED` /
/// `ENCODINGS_IN_LABEL_SORT` label table) to resolve to the exact same
/// `&'static Encoding` as the "windows-1252" label: both point at
/// `WINDOWS_1252_INIT`, i.e. `Encoding::for_label(b"iso-8859-1") ==
/// Encoding::for_label(b"windows-1252")`. This is intentional upstream --
/// the Encoding Standard requires content labeled ISO-8859-1 on the web to
/// actually be decoded as Windows-1252 for legacy-web compatibility -- so
/// there is no separate "true Latin-1" decoder available to offer as a
/// distinct candidate here; listing both labels would just enter the
/// identical hypothesis twice.
/// The `(intermediate, original)` hypotheses worth testing, restricted to
/// mis-decode shapes that actually occur in the wild:
///
/// 1. East Asian or UTF-8 bytes opened by a Western tool whose default is
///    Windows-1252 (the dominant real-world case),
/// 2. UTF-8 bytes opened on a system defaulting to a CJK legacy encoding,
///    and
/// 3. Windows-1251 bytes opened by a tool defaulting to KOI8-R (issue
///    #182) -- the classic Runet "кракозябры" mojibake, from the decades
///    where Unix/Fidonet mail and web tooling defaulted to KOI8-R while
///    Windows defaulted to windows-1251.
///
/// Legacy-CJK ↔ legacy-CJK pairs (e.g. GBK-encode → Big5-decode) are
/// deliberately absent: adversarial review demonstrated that perfectly
/// valid Japanese text passes every structural gate for (GBK, Big5) —
/// clean encode, clean decode, zero U+FFFD, chardetng agreement — while
/// producing garbage, because the CJK legacy encodings overlap enough that
/// chardetng's frequency model cannot referee between them on re-encoded
/// text. The real-world scenario they would repair (a CJK file mis-opened
/// under another CJK encoding, then re-saved) is also vanishingly rare:
/// the result is full-screen garbage nobody keeps working in. Narrow and
/// right beats broad and wrong for a repair tool.
///
/// `(WINDOWS_1251, KOI8_R)` -- the reverse of the pair below, i.e. genuine
/// KOI8-R bytes mis-decoded as windows-1251 -- is deliberately absent, and
/// for a *structural*, not just statistical, reason this time: chardetng
/// 0.1.17 has no KOI8-R candidate in its detection model at all, only
/// KOI8-U (its README's "Notes About Encodings" lists "KOI8-R: Detected as
/// KOI8-U (Always guessing the U variant is less likely to corrupt
/// non-box drawing characters.)"; confirmed directly against the crate's
/// `SINGLE_BYTE_DATA` table, which has 21 candidates and no `KOI8_R_INIT`
/// among them; `src/encodings.ts`'s `MANUAL_ONLY_ENCODINGS` documents the
/// identical fact for this app's own open-file auto-detect). Gate (c)
/// below requires chardetng's cold guess on the recovered bytes to equal
/// `original`; when `original` is `KOI8_R` that comparison can *never*
/// succeed, for any input whatsoever -- verified empirically too: genuine
/// KOI8-R text mis-decoded as windows-1251 structurally passes gates (a)
/// and (b) (clean encode, clean decode) but chardetng still guesses
/// KOI8-U on the recovered bytes, so gate (c) rejects it every time. Since
/// this wizard's UI only ever offers candidates `detect_mojibake` returns
/// (`src/mojibake.ts`'s `showMojibakeWizard` has no manual pair picker),
/// an `original: KOI8_R` entry would be permanently unreachable dead code
/// -- not a working-but-rare hypothesis, a candidate that can *never*
/// appear.
///
/// ISO-8859-5 hypotheses (`windows-1251`/`KOI8-R` ↔ `ISO-8859-5`) were
/// evaluated for issue #182 and left out too: ISO-8859-5 is the least
/// common of the three encodings in real-world Cyrillic mojibake (curated
/// per E1 mainly for IANA mail-standard completeness), and empirically the
/// (windows-1251, ISO-8859-5) / (ISO-8859-5, windows-1251) pairing is
/// actively ambiguous rather than merely lower-priority: genuine
/// ISO-8859-5 bytes mis-decoded as windows-1251 pass every gate --
/// including chardetng agreement -- under *both* the correct hypothesis
/// and the reversed, wrong one, and the wrong one recovers a different,
/// incorrect text. Two structurally-clean-but-contradictory candidates for
/// the same input is exactly the ambiguity the CJK exclusion above avoids;
/// adding this pairing would reintroduce that failure mode rather than
/// widen coverage, and would do so specifically for the rarest of the
/// three encodings. See this module's
/// `windows1251_iso88595_hypotheses_are_mutually_ambiguous` test for the
/// reproducing case.
///
/// `(WINDOWS_1252, EUC_JP)` -- genuine EUC-JP bytes mis-decoded as
/// windows-1252 -- was evaluated for ROADMAP v0.6 E2 and passed both
/// required gates, so unlike the three exclusions just above, this one
/// was *included*. Gate 1 (reachability): chardetng 0.1.17 carries a
/// real, positively-detected EUC-JP candidate (`EucJpCandidate` /
/// `EUC_JP_INDEX` in its `src/lib.rs`; its README lists EUC-JP under
/// "Detected: Historical locale-specific fallbacks", not aliased away the
/// way GB18030->GBK or KOI8-R->KOI8-U are) -- structurally unlike the
/// absent-candidate KOI8-R case above, so this hypothesis is reachable in
/// principle, confirmed empirically on diverse real Japanese text by
/// `repairs_eucjp_misdecoded_as_windows1252`. Gate 2 (mutual ambiguity):
/// unlike the ISO-8859-5 case just above, the reversed hypothesis,
/// (EUC_JP, WINDOWS_1252), does not also pass on the same genuine-EUC-JP-
/// as-1252 mojibake (`windows1252_eucjp_reverse_hypothesis_is_rejected`);
/// legitimate windows-1252 Western-European prose does not trigger this
/// pair either (`no_candidates_for_normal_western_european_text`); and it
/// does not shadow the existing Big5/Shift_JIS pairs' correct hits on
/// their own genuine mojibake
/// (`windows1252_eucjp_pair_does_not_shadow_existing_cjk_pairs`).
///
/// `pub(crate)` so `fuzz_roundtrip.rs`'s reversibility fuzz can iterate
/// this exact list instead of maintaining a separately-drifting copy.
pub(crate) const REPAIR_PAIRS: [(&Encoding, &Encoding); 10] = [
    (WINDOWS_1252, UTF_8),
    (WINDOWS_1252, BIG5),
    (WINDOWS_1252, GB18030),
    (WINDOWS_1252, SHIFT_JIS),
    (WINDOWS_1252, EUC_KR),
    // ROADMAP v0.6 E2: see the doc comment above for the two-gate
    // evaluation this pair passed.
    (WINDOWS_1252, EUC_JP),
    (BIG5, UTF_8),
    (GBK, UTF_8),
    (SHIFT_JIS, UTF_8),
    // Issue #182: genuine windows-1251 bytes mis-decoded as KOI8-R --
    // see the doc comment above for why only this direction is listed.
    (KOI8_R, WINDOWS_1251),
];

/// `detect_mojibake` samples at most this many bytes of `content`.
/// `apply_mojibake_repair` always runs the same round trip over the full
/// text, never just the sample -- see its doc comment.
const SAMPLE_BYTES: usize = 64 * 1024;

/// `RepairCandidate::preview` shows at most this many characters.
const PREVIEW_CHARS: usize = 200;

/// At most this many candidates are ever returned, strongest first.
const MAX_CANDIDATES: usize = 5;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepairCandidate {
    /// The wrong encoding the bytes were mis-decoded with, e.g. "windows-1252".
    pub intermediate: String,
    /// The encoding the bytes actually are, e.g. "Big5".
    pub original: String,
    /// First ~200 characters of the repaired text (char-boundary safe).
    pub preview: String,
    /// Heuristic count of characters that differ between the current
    /// (mojibake) sample and this candidate's repaired sample -- see
    /// `count_char_differences`. Used to rank candidates (higher first)
    /// and to give the UI a concrete "this changes about N characters"
    /// number.
    pub replacement_count: usize,
}

/// The longest prefix of `s` that is at most `max_bytes` long and ends on a
/// UTF-8 character boundary. `str::is_char_boundary(0)` is always `true`,
/// so this loop always terminates, even for content that is one giant
/// character run straddling the cut point.
fn char_boundary_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// First `max_chars` Unicode scalar values of `s` -- trivially char-boundary
/// safe since it walks `chars()` rather than slicing bytes.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Rough "is this character East Asian" test: CJK ideographs (plus the
/// Extension-A block and the compatibility block), hiragana/katakana, and
/// Hangul syllables. This is a sort tiebreaker, not an exhaustive Unicode
/// block classification.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // Hiragana, Katakana
        | 0x3400..=0x4DBF // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7A3 // Hangul syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
    )
}

/// Fraction of `text`'s characters that are East Asian. Only used to break
/// ties between candidates that repair a sample equally well by
/// `replacement_count`: East Asian mojibake is this feature's primary
/// scenario, so given two equally-plausible repairs, the one recovering
/// more CJK text is more likely to be the right one.
fn cjk_ratio(text: &str) -> f64 {
    let total = text.chars().count();
    if total == 0 {
        return 0.0;
    }
    let cjk = text.chars().filter(|&c| is_cjk(c)).count();
    cjk as f64 / total as f64
}

/// Heuristic "how many characters would change" between the current
/// mojibake sample and a candidate's repaired sample: a plain positional
/// comparison, counting a mismatch at every position the two differ plus
/// one for every character of any trailing length difference. This is not
/// a true edit-distance diff, but mojibake corrupts nearly every
/// multi-byte character in the affected run, so this coarse count already
/// tracks "how much of the text is actually being fixed" well enough to
/// rank candidates and to show the user a concrete number.
fn count_char_differences(a: &str, b: &str) -> usize {
    let mut ac = a.chars();
    let mut bc = b.chars();
    let mut count = 0usize;
    loop {
        match (ac.next(), bc.next()) {
            (None, None) => break,
            (Some(x), Some(y)) => {
                if x != y {
                    count += 1;
                }
            }
            _ => count += 1,
        }
    }
    count
}

/// Decode `bytes` as `enc`, tolerating an incomplete multi-byte sequence
/// at the very end only: trims 0–3 trailing bytes (GB18030's longest
/// sequence is 4) until the remainder decodes with zero malformed
/// sequences. Returns the decoded text plus the byte length that decoded
/// cleanly; `None` when no trim length yields a clean decode — i.e. the
/// damage is interior, which genuinely refutes the hypothesis rather than
/// being a sampling artifact.
fn decode_tolerating_truncated_tail(
    bytes: &[u8],
    enc: &'static Encoding,
) -> Option<(String, usize)> {
    for trim in 0..=3usize.min(bytes.len()) {
        let end = bytes.len() - trim;
        let (decoded, malformed) = enc.decode_without_bom_handling(&bytes[..end]);
        if !malformed {
            return Some((decoded.into_owned(), end));
        }
    }
    None
}

/// Try one `(intermediate, original)` hypothesis against `sample`. Returns
/// the repaired text and its CJK ratio when every quality gate passes,
/// `None` the moment any gate rejects the hypothesis.
fn try_repair(
    sample: &str,
    intermediate: &'static Encoding,
    original: &'static Encoding,
) -> Option<(String, f64)> {
    // Gate (a): `sample` must be exactly representable in `intermediate`.
    // If any character can't be, `sample` cannot possibly be
    // `intermediate`'s decoding of anything, so this hypothesis is wrong
    // on its face.
    let (bytes, _, unmappable) = intermediate.encode(sample);
    if unmappable {
        return None;
    }
    // Gate (b): the recovered bytes must decode cleanly as `original`.
    // `decode_without_bom_handling` is used deliberately instead of
    // `decode` (which sniffs a BOM and can silently swap encodings, e.g.
    // jumping from UTF-8 to UTF-16 on a stray `FF FE`) or
    // `decode_with_bom_removal` (irrelevant: these recovered bytes never
    // legitimately carry an original-file BOM at this point -- if the
    // original bytes had genuinely started with one, auto-detection would
    // have caught it long before this content ever became mojibake).
    //
    // The sample path tolerates a truncated *tail* only: the char-boundary
    // sample cut lands mid-character in the *recovered* byte stream about
    // half the time for CJK mojibake (each garbled character re-encodes to
    // part of a multi-byte sequence), and without this tolerance every
    // >SAMPLE_BYTES document would silently detect nothing — an artifact
    // of sampling, not evidence against the hypothesis. Interior damage
    // still rejects: trimming at most 3 bytes (GB18030's longest sequence
    // is 4) must yield a perfectly clean decode. `apply_mojibake_repair`
    // runs the full text with no tolerance at all.
    let (repaired, clean_len) = decode_tolerating_truncated_tail(&bytes, original)?;
    // Gate (c): no replacement characters (implied by `!malformed` above,
    // but checked explicitly since it is the actual promise being made to
    // the caller), and chardetng -- fed the same bytes cold, independent
    // of this hypothesis -- must independently agree the bytes are
    // `original`. This is what rejects "structurally clean but
    // statistically wrong" hypotheses: e.g. genuine Big5 text
    // re-interpreted as GB18030 can sometimes decode without a single
    // malformed sequence, but chardetng's frequency model still tells the
    // two apart. Gatekeeper order matters, though: for the
    // (windows-1252, multi-byte-CJK) family it is the *structural* gate
    // above -- the re-encoded high bytes must form valid, contiguous
    // multi-byte sequences, which real Western prose (accents separated
    // by ASCII/spaces) never does -- that rejects nearly everything;
    // chardetng alone would accept a measurable share of dense
    // high-byte-only strings (adversarial review measured ~7% of random
    // contiguous A1-FE even-length strings passing it for EUC-JP), so a
    // future relaxation of the structural gate must not lean on
    // chardetng as the sole remaining referee.
    if repaired.contains('\u{FFFD}') {
        return None;
    }
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes[..clean_len], true);
    if detector.guess(None, true) != original {
        return None;
    }
    let ratio = cjk_ratio(&repaired);
    Some((repaired, ratio))
}

/// Detect candidate mojibake repairs for `content`. Samples at most
/// `SAMPLE_BYTES` (char-boundary safe) so this stays cheap even for large
/// documents; the repair itself, in `apply_mojibake_repair`, always runs
/// over the full text. Returns at most `MAX_CANDIDATES` candidates, ranked
/// by `replacement_count` descending, then by post-repair CJK ratio
/// descending.
#[tauri::command]
pub fn detect_mojibake(content: String) -> Vec<RepairCandidate> {
    let sample = char_boundary_prefix(&content, SAMPLE_BYTES);
    let mut scored: Vec<(RepairCandidate, f64)> = Vec::new();

    for &(intermediate, original) in REPAIR_PAIRS.iter() {
        let Some((repaired, ratio)) = try_repair(sample, intermediate, original) else {
            continue;
        };
        // Gate (d): no visible change means this pair -- however
        // structurally valid -- does not actually repair anything
        // (pure ASCII round-trips identically through every candidate
        // pair here); never offer a no-op "repair".
        if repaired == sample {
            continue;
        }
        let replacement_count = count_char_differences(sample, &repaired);
        let preview = truncate_chars(&repaired, PREVIEW_CHARS);
        scored.push((
            RepairCandidate {
                intermediate: intermediate.name().to_string(),
                original: original.name().to_string(),
                preview,
                replacement_count,
            },
            ratio,
        ));
    }

    scored.sort_by(|(a, a_ratio), (b, b_ratio)| {
        b.replacement_count.cmp(&a.replacement_count).then_with(|| {
            b_ratio
                .partial_cmp(a_ratio)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    scored.truncate(MAX_CANDIDATES);
    scored.into_iter().map(|(candidate, _)| candidate).collect()
}

/// Re-run the same encode/decode round trip `detect_mojibake` previewed,
/// but over the *entire* document text -- and fail loudly instead of
/// silently corrupting anything. A detection sample (at most
/// `SAMPLE_BYTES`) passing every gate does not guarantee the rest of a
/// large document has no character `intermediate` can't encode, or no byte
/// sequence `original` can't decode; this is the actual safety net for
/// that gap. Never writes to disk -- the caller decides what to do with
/// the returned text (ARCHITECTURE.md: the frontend owns in-memory text,
/// the user decides when to save).
#[tauri::command]
pub fn apply_mojibake_repair(
    content: String,
    intermediate: String,
    original: String,
) -> Result<String, String> {
    let intermediate_enc = Encoding::for_label(intermediate.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {intermediate}"))?;
    let original_enc = Encoding::for_label(original.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {original}"))?;

    let (bytes, _, unmappable) = intermediate_enc.encode(&content);
    if unmappable {
        return Err(format!(
            "Some characters in the document can't be represented in {intermediate}; \
             repairing would lose data, so nothing was changed."
        ));
    }
    let (repaired, malformed) = original_enc.decode_without_bom_handling(&bytes);
    if malformed {
        return Err(format!(
            "The recovered bytes are not valid {original}; repairing would corrupt \
             the document, so nothing was changed."
        ));
    }
    Ok(repaired.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic, reasonably long Traditional Chinese sample -- the same
    /// fixture `encoding.rs`'s own `detects_big5_from_realistic_sample`
    /// test uses, since it is already proven to be reliably chardetng-
    /// detected as Big5 (statistical detection needs a realistic amount of
    /// text; a few bytes are genuinely ambiguous across legacy encodings).
    const BIG5_TEXT: &str =
        "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";

    /// Reasonably long Japanese sample mixing kanji, hiragana and
    /// katakana, mirroring `BIG5_TEXT`'s shape for Shift_JIS.
    const SHIFT_JIS_TEXT: &str = "日本語文字エンコーディングの検出テストです。これは自動検出機能を検証するための文章であり、句読点や一般的な語彙も含まれています。";

    /// Realistic Russian sample for the Cyrillic hypothesis (issue #182):
    /// a classic Russian pangram ("Съешь же ещё этих мягких французских
    /// булок, да выпей чаю" -- "Eat some more of these soft French rolls,
    /// and drink some tea", used precisely because it exercises every
    /// letter of the modern Cyrillic alphabet) plus a second sentence for
    /// length, mirroring `BIG5_TEXT`/`SHIFT_JIS_TEXT`'s "realistic amount
    /// of text" reasoning. Deliberately ASCII-punctuation-only (plain `.`
    /// and `,`, no curly quotes or "№") so it is exactly representable in
    /// windows-1251, KOI8-R, *and* ISO-8859-5 alike -- confirmed
    /// empirically while evaluating this issue, and depended on by the
    /// ISO-8859-5-ambiguity regression test below, which needs the same
    /// text clean-encodable in all three.
    const RUSSIAN_TEXT: &str = "Съешь же ещё этих мягких французских булок, да выпей чаю. Это пример текста для проверки кодировки после перекодирования.";

    /// Western-European accented text built only from lowercase Latin-1
    /// Supplement characters U+00E1..=U+00FF. Restricting to this range is
    /// deliberate: each such character is exactly 2 UTF-8 bytes `C3 xx`
    /// with `xx` in `A1..=BF`, which is simultaneously a valid Big5
    /// lead/trail byte pair (Big5 lead bytes span `81..=FE`, trail bytes
    /// span `40..=7E` and `A1..=FE`) -- so this text's raw UTF-8 bytes are
    /// *guaranteed* to Big5-decode without a single malformed sequence,
    /// which `repairs_utf8_misdecoded_as_big5` depends on. (Codepoints
    /// below U+00E1, e.g. plain "à", land the second UTF-8 byte in
    /// `80..=A0`, which Big5 rejects as a trail byte -- avoided here.)
    const LATIN1_SUPPLEMENT_TEXT: &str = "café où l'étoile étée ça résumé vécu ôté née bébé";

    /// ROADMAP v0.6 E2 evaluation fixture: diverse EUC-JP text for the
    /// (WINDOWS_1252, EUC_JP) mojibake pair under evaluation. Three
    /// unrelated-topic sentences (weather, a library/cafe visit, an
    /// evening meal) so the fixture exercises kanji, hiragana, *and*
    /// katakana together rather than one script in isolation --
    /// deliberately distinct content from `SHIFT_JIS_TEXT` above (same
    /// "reasonably long, multi-sentence" shape for chardetng's statistical
    /// detection) so this pair's evaluation is not just re-running the
    /// Shift_JIS fixture under a different label.
    const EUC_JP_TEXT: &str = "今日は朝から雨が降っていて、少し肌寒い一日でした。図書館で新しい小説を借り、カフェでコーヒーを飲みながら静かな時間を過ごしました。夕方には近所の店で温かい料理を食べて、心も体も温まりました。";

    /// ROADMAP v0.6 E2 evaluation fixture: realistic French prose using
    /// common windows-1252 Western-European accented characters (é, è, ê,
    /// ô, ç, ù) in natural sentences. Unlike `LATIN1_SUPPLEMENT_TEXT`
    /// above -- deliberately restricted to lowercase U+00E1..=U+00FF for
    /// its Big5-collision property -- this fixture exists purely to stand
    /// in for "a real windows-1252 document a user might have open", for
    /// the false-positive check below.
    const WESTERN_EUROPEAN_TEXT: &str = "Le café est déjà prêt, mais l'hôtel n'a pas encore reçu la réservation. Où puis-je trouver une pharmacie près d'ici ? C'est très important pour moi.";

    #[test]
    fn repairs_big5_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable, "fixture must be fully Big5-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, BIG5_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "Big5")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, Big5) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, BIG5_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "Big5".to_string())
                .unwrap();
        assert_eq!(repaired, BIG5_TEXT);
    }

    #[test]
    fn repairs_utf8_misdecoded_as_windows1252() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );
        // Pin the classic "Ã©"-style shape: each 2-byte UTF-8 char becomes
        // two separate mojibake characters once mis-decoded byte-by-byte.
        assert!(mojibake.contains('Ã'));

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn repairs_shiftjis_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = SHIFT_JIS.encode(SHIFT_JIS_TEXT);
        assert!(!unmappable, "fixture must be fully Shift_JIS-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, SHIFT_JIS_TEXT,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "Shift_JIS")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, Shift_JIS) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, SHIFT_JIS_TEXT);

        let repaired = apply_mojibake_repair(
            mojibake,
            "windows-1252".to_string(),
            "Shift_JIS".to_string(),
        )
        .unwrap();
        assert_eq!(repaired, SHIFT_JIS_TEXT);
    }

    /// ROADMAP v0.6 E2, gate 1 (reachability): genuine EUC-JP bytes
    /// mis-decoded as windows-1252, same shape as
    /// `repairs_shiftjis_misdecoded_as_windows1252` above. chardetng
    /// 0.1.17 carries a real, positively-detected EUC-JP candidate
    /// (`EucJpCandidate` / `EUC_JP_INDEX` in its `src/lib.rs`, and its
    /// README lists EUC-JP under "Detected: Historical locale-specific
    /// fallbacks", not aliased away the way GB18030->GBK or KOI8-R->KOI8-U
    /// are) -- structurally unlike the absent-candidate KOI8-R case
    /// documented on `REPAIR_PAIRS` and in judgment-overlay.md §4, so this
    /// hypothesis is not dead on arrival. This test is the empirical
    /// confirmation that gate (c)'s chardetng cross-check actually agrees
    /// on real, diverse Japanese text, not just the structural possibility.
    #[test]
    fn repairs_eucjp_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = EUC_JP.encode(EUC_JP_TEXT);
        assert!(!unmappable, "fixture must be fully EUC-JP-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, EUC_JP_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, EUC-JP) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, EUC_JP_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "EUC-JP".to_string())
                .unwrap();
        assert_eq!(repaired, EUC_JP_TEXT);
    }

    #[test]
    fn repairs_utf8_misdecoded_as_big5() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = BIG5.decode_without_bom_handling(bytes);
        assert!(
            !malformed,
            "fixture is constructed so its UTF-8 bytes are valid Big5 lead/trail pairs"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "Big5" && c.original == "UTF-8")
            .unwrap_or_else(|| panic!("expected a (Big5, UTF-8) candidate, got {candidates:?}"));
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "Big5".to_string(), "UTF-8".to_string()).unwrap();
        assert_eq!(repaired, original_text);
    }

    /// Issue #182: genuine windows-1251 bytes wrongly opened as KOI8-R --
    /// the classic Runet "кракозябры" mojibake shape (KOI8-R was the
    /// standard Unix/Fidonet encoding, windows-1251 the standard Windows
    /// one; tools defaulting to the wrong one produced this constantly).
    #[test]
    fn repairs_windows1251_misdecoded_as_koi8r() {
        let (bytes, _, unmappable) = WINDOWS_1251.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully windows-1251-encodable");
        let (mojibake, malformed) = KOI8_R.decode_without_bom_handling(&bytes);
        assert!(
            !malformed,
            "fixture bytes must also decode cleanly as KOI8-R"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, RUSSIAN_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "KOI8-R" && c.original == "windows-1251")
            .unwrap_or_else(|| {
                panic!("expected a (KOI8-R, windows-1251) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, RUSSIAN_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "KOI8-R".to_string(), "windows-1251".to_string())
                .unwrap();
        assert_eq!(repaired, RUSSIAN_TEXT);
    }

    #[test]
    fn pure_ascii_yields_no_candidates() {
        let text = "Hello, World! This is plain ASCII text with no accents at all.".to_string();
        assert_eq!(detect_mojibake(text), Vec::new());
    }

    #[test]
    fn normal_utf8_chinese_content_has_no_content_changing_candidates() {
        // Genuinely correct, un-garbled UTF-8 Chinese text must never be
        // flagged: every candidate `detect_mojibake` could ever return
        // necessarily changes the content (gate (d) filters out anything
        // that wouldn't), so "no candidate changes the content" means this
        // list must be empty.
        let candidates = detect_mojibake(BIG5_TEXT.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct UTF-8 Chinese text must not be mistaken for mojibake"
        );
    }

    /// Adversarial-review regression: correct Japanese used to pass every
    /// structural gate for the (GBK, Big5) hypothesis — clean encode,
    /// clean decode, zero U+FFFD, and chardetng agreeing the re-encoded
    /// bytes look like Big5 — while producing pure garbage. The pair
    /// matrix now excludes legacy-CJK ↔ legacy-CJK hypotheses entirely;
    /// this locks that correct Japanese yields no candidate at all.
    #[test]
    fn no_candidates_for_normal_japanese() {
        for text in [
            "日本語の文章です。これはテストであり句読点も含まれています。",
            "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
        ] {
            let candidates = detect_mojibake(text.to_string());
            assert_eq!(
                candidates,
                Vec::new(),
                "correct Japanese must not be mistaken for mojibake: {text}"
            );
        }
    }

    /// Same shape as the Japanese case for Hangul: correct Korean must
    /// never produce a content-changing candidate.
    #[test]
    fn no_candidates_for_normal_korean() {
        let text = "안녕하세요. 이것은 한국어 테스트 문장입니다. 데이터가 손상되면 안 됩니다.";
        let candidates = detect_mojibake(text.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct Korean must not be mistaken for mojibake"
        );
    }

    /// Same shape again for Cyrillic: correct Russian text, in its native
    /// UTF-8 form and never touched by any encoding round-trip, must never
    /// produce a content-changing candidate.
    #[test]
    fn no_candidates_for_normal_cyrillic() {
        let candidates = detect_mojibake(RUSSIAN_TEXT.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct Russian text must not be mistaken for mojibake"
        );
    }

    /// ROADMAP v0.6 E2, gate 2a (false-positive check): a real, correctly-
    /// decoded windows-1252 Western-European document -- never touched by
    /// any mis-decode -- must not trigger the new (WINDOWS_1252, EUC_JP)
    /// hypothesis. Same family as `no_candidates_for_normal_japanese`
    /// /`_korean`/`_cyrillic` above, extended to the script this new
    /// pair's `intermediate` encoding natively serves. Scoped to the
    /// specific new candidate (not "candidates must be empty" overall)
    /// because that is the literal risk this pair introduces: whether
    /// legitimate windows-1252 prose can also pass this one new gate,
    /// independent of whatever the four pre-existing (WINDOWS_1252, *)
    /// pairs already do or don't do with this text.
    #[test]
    fn no_candidates_for_normal_western_european_text() {
        let candidates = detect_mojibake(WESTERN_EUROPEAN_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "correct Western-European windows-1252 text must not trigger a false-positive \
             (windows-1252, EUC-JP) repair candidate: {candidates:?}"
        );
    }

    /// Adversarial-review regression: the 64 KiB sample cut lands
    /// mid-character in the *recovered* byte stream about half the time
    /// for CJK mojibake, and gate (b) used to reject the whole hypothesis
    /// over that sampling artifact — large documents silently detected
    /// nothing. With tail tolerance, detection must keep working past the
    /// sample boundary at any alignment.
    #[test]
    fn detects_mojibake_in_content_over_sample_boundary() {
        let (bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable);
        let (unit, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed);
        let unit = unit.into_owned();

        // Both sizes straddle SAMPLE_BYTES with different tail alignments
        // (the second reproduces the adversarial review's failing case).
        for target in [SAMPLE_BYTES + 2_000, SAMPLE_BYTES + 38_000] {
            let mut mojibake = String::new();
            while mojibake.len() < target {
                mojibake.push_str(&unit);
            }
            let candidates = detect_mojibake(mojibake);
            assert!(
                candidates
                    .iter()
                    .any(|c| c.intermediate == "windows-1252" && c.original == "Big5"),
                "large mojibake (~{target} bytes) must still be detected, got {candidates:?}"
            );
        }
    }

    /// Issue #182 evaluation: documents/locks in *why* `(WINDOWS_1251,
    /// KOI8_R)` is excluded from `REPAIR_PAIRS` (see that const's doc
    /// comment). Gates (a) and (b) of `try_repair` pass cleanly for a
    /// genuine KOI8-R-as-windows-1251 mis-decode -- the encode/decode
    /// round trip itself is perfectly reversible -- but gate (c)'s
    /// chardetng cross-check can never confirm `KOI8_R` as `original`,
    /// because chardetng has no KOI8-R candidate in its statistical model
    /// at all (only KOI8-U). This is a structural rejection, not a
    /// judgment call about this particular fixture.
    #[test]
    fn koi8_r_can_never_be_confirmed_as_original_by_chardetng() {
        let (real_bytes, _, unmappable) = KOI8_R.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully KOI8-R-encodable");
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(&real_bytes);
        assert!(
            !malformed,
            "windows-1251 must decode the KOI8-R bytes cleanly"
        );
        let mojibake = mojibake.into_owned();

        // Gates (a)+(b) alone (plain encode/decode, no chardetng): the
        // round trip is perfectly clean and recovers the exact original
        // bytes and text.
        let (recovered_bytes, _, unmappable) = WINDOWS_1251.encode(&mojibake);
        assert!(!unmappable);
        assert_eq!(recovered_bytes.as_ref(), real_bytes.as_ref());
        let (recovered_text, malformed) = KOI8_R.decode_without_bom_handling(&recovered_bytes);
        assert!(!malformed);
        assert_eq!(recovered_text, RUSSIAN_TEXT);

        // But try_repair -- which also runs gate (c) -- must still reject
        // it, because chardetng can never guess KOI8_R specifically.
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1251, KOI8_R),
            None,
            "chardetng cannot confirm KOI8-R as `original`, so this \
             hypothesis must never pass even though the encode/decode \
             round trip itself is perfectly clean"
        );

        // Pin the specific reason: chardetng guesses KOI8-U, never KOI8-R.
        let mut detector = EncodingDetector::new();
        detector.feed(&real_bytes, true);
        assert_eq!(detector.guess(None, true).name(), "KOI8-U");
    }

    /// Issue #182 evaluation: documents/locks in *why* ISO-8859-5
    /// hypotheses were left out of `REPAIR_PAIRS` (see that const's doc
    /// comment). Genuine ISO-8859-5 bytes mis-decoded as windows-1251 pass
    /// every one of `try_repair`'s gates -- including chardetng agreement
    /// -- under *both* the correct hypothesis, (windows-1251, ISO-8859-5),
    /// *and* the reversed, wrong one, (ISO-8859-5, windows-1251), which
    /// recovers different, incorrect text. Shipping this pairing would
    /// show the wizard user two structurally-clean candidates for the
    /// same mojibake, one of them wrong.
    #[test]
    fn windows1251_iso88595_hypotheses_are_mutually_ambiguous() {
        use encoding_rs::ISO_8859_5;

        let (real_bytes, _, unmappable) = ISO_8859_5.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully ISO-8859-5-encodable");
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(&real_bytes);
        assert!(
            !malformed,
            "windows-1251 must decode the ISO-8859-5 bytes cleanly"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, RUSSIAN_TEXT, "fixture must actually look garbled");

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1251, ISO_8859_5)
            .expect("the correct (windows-1251, ISO-8859-5) hypothesis must pass every gate");
        assert_eq!(
            correct_text, RUSSIAN_TEXT,
            "the correct hypothesis must recover the real text"
        );

        let (wrong_text, _) = try_repair(&mojibake, ISO_8859_5, WINDOWS_1251).expect(
            "the reversed (ISO-8859-5, windows-1251) hypothesis ALSO passes every \
             gate -- this is exactly the ambiguity that keeps it out of REPAIR_PAIRS",
        );
        assert_ne!(
            wrong_text, RUSSIAN_TEXT,
            "the reversed hypothesis passing every gate while recovering the WRONG \
             text is the documented collision -- if this ever starts recovering the \
             right text too, the ambiguity argument in REPAIR_PAIRS's doc comment \
             needs re-checking before adding ISO-8859-5 pairs"
        );
    }

    /// ROADMAP v0.6 E2, gate 2b (mutual-ambiguity check): same shape as
    /// `windows1251_iso88595_hypotheses_are_mutually_ambiguous` above, but
    /// checking the *reverse* of the pair under evaluation here. Genuine
    /// EUC-JP bytes mis-decoded as windows-1252 pass the forward
    /// hypothesis, (WINDOWS_1252, EUC_JP) -- the one ROADMAP v0.6 E2 asks
    /// to evaluate -- and recover the real text. Unlike the ISO-8859-5
    /// case, the reversed hypothesis, (EUC_JP, WINDOWS_1252) (i.e. "this
    /// text is EUC-JP-decoded bytes that were really windows-1252"), must
    /// NOT also pass: if it did, the same mojibake string would have two
    /// structurally-clean-but-contradictory readings, exactly the
    /// ambiguity that kept ISO-8859-5 out.
    #[test]
    fn windows1252_eucjp_reverse_hypothesis_is_rejected() {
        let (real_bytes, _, unmappable) = EUC_JP.encode(EUC_JP_TEXT);
        assert!(!unmappable, "fixture must be fully EUC-JP-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&real_bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, EUC_JP_TEXT, "fixture must actually look garbled");

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1252, EUC_JP)
            .expect("the forward (windows-1252, EUC-JP) hypothesis must pass every gate");
        assert_eq!(
            correct_text, EUC_JP_TEXT,
            "the forward hypothesis must recover the real text"
        );

        assert_eq!(
            try_repair(&mojibake, EUC_JP, WINDOWS_1252),
            None,
            "the reversed (EUC_JP, windows-1252) hypothesis must not also pass -- if it \
             ever starts passing, this pair has the same mutual-ambiguity problem that \
             kept (windows-1251, ISO-8859-5) out of REPAIR_PAIRS"
        );
    }

    /// ROADMAP v0.6 E2, gate 2c (interaction with the nine pairs that
    /// predate this evaluation): the new (WINDOWS_1252, EUC_JP)
    /// hypothesis must not shadow an existing pair's correct hit on real
    /// mojibake. Reuses the same
    /// Big5- and Shift_JIS-via-windows-1252 mojibake the `repairs_*` tests
    /// above already build and pin -- a real Big5 (or Shift_JIS) file
    /// mis-decoded as windows-1252 must keep resolving to its own correct
    /// pair only, never spuriously also to (windows-1252, EUC-JP).
    #[test]
    fn windows1252_eucjp_pair_does_not_shadow_existing_cjk_pairs() {
        let (big5_bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable);
        let (big5_mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&big5_bytes);
        assert!(!malformed);
        let big5_candidates = detect_mojibake(big5_mojibake.into_owned());
        assert!(
            big5_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "Big5"),
            "the real Big5 pair must still be found: {big5_candidates:?}"
        );
        assert!(
            !big5_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "a genuine Big5-as-windows-1252 mojibake must not also spuriously match the \
             EUC-JP hypothesis: {big5_candidates:?}"
        );

        let (sjis_bytes, _, unmappable) = SHIFT_JIS.encode(SHIFT_JIS_TEXT);
        assert!(!unmappable);
        let (sjis_mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&sjis_bytes);
        assert!(!malformed);
        let sjis_candidates = detect_mojibake(sjis_mojibake.into_owned());
        assert!(
            sjis_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "Shift_JIS"),
            "the real Shift_JIS pair must still be found: {sjis_candidates:?}"
        );
        assert!(
            !sjis_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "a genuine Shift_JIS-as-windows-1252 mojibake must not also spuriously match \
             the EUC-JP hypothesis: {sjis_candidates:?}"
        );
    }

    #[test]
    fn apply_rejects_unmappable_content_with_readable_error() {
        let err = apply_mojibake_repair(
            "rocket 🚀 emoji is not in Big5".to_string(),
            "Big5".to_string(),
            "UTF-8".to_string(),
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(err.contains("Big5"));
    }

    #[test]
    fn apply_rejects_content_whose_recovered_bytes_are_malformed_in_original() {
        // Big5-encoding this realistic Chinese sample, then trying to
        // decode those bytes as EUC-KR (a different double-byte encoding
        // with different valid trail-byte ranges) must fail cleanly rather
        // than silently emit replacement characters.
        let err = apply_mojibake_repair(
            BIG5_TEXT.to_string(),
            "Big5".to_string(),
            "EUC-KR".to_string(),
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(err.contains("EUC-KR"));
    }

    #[test]
    fn detection_on_content_over_64kib_does_not_panic() {
        // "中" is 3 UTF-8 bytes; 30,000 repeats is 90,000 bytes, and
        // SAMPLE_BYTES (65,536) lands one byte inside a character (65,536
        // is not a multiple of 3), exercising the char-boundary retreat in
        // `char_boundary_prefix` instead of trivially landing on one.
        let big = "中".repeat(30_000);
        assert!(big.len() > SAMPLE_BYTES);
        assert!(!big.is_char_boundary(SAMPLE_BYTES));
        let candidates = detect_mojibake(big);
        assert!(candidates.len() <= MAX_CANDIDATES);
    }

    #[test]
    fn char_boundary_prefix_handles_short_content() {
        assert_eq!(char_boundary_prefix("hi", SAMPLE_BYTES), "hi");
    }
}
