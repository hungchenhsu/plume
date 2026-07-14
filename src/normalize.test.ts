import { describe, expect, it } from "vitest";
import {
  countChangedSequences,
  isNfc,
  isNfcChunked,
  isNormalized,
  isNormalizedChunked,
  planNormalization,
} from "./normalize";

// "café" spelled with a combining acute accent (NFD) vs. the precomposed
// "é" (NFC) — the canonical minimal fixture for this whole feature: this
// exact sequence is what ROADMAP.md/the planning critic flagged as
// unrepresentable in Big5/Shift_JIS even though the precomposed form is
// fine in many legacy encodings that at least cover Latin-1.
const NFD_CAFE = "café"; // c a f e + combining acute accent
const NFC_CAFE = "café"; // precomposed U+00E9

describe("isNormalized / isNfc", () => {
  it("is true for plain ASCII", () => {
    expect(isNormalized("hello world", "NFC")).toBe(true);
    expect(isNfc("hello world")).toBe(true);
  });

  it("is true for CJK text under both NFC and NFD (no canonical decomposition)", () => {
    const text = "中文編碼偵測測試";
    expect(isNfc(text)).toBe(true);
    expect(isNormalized(text, "NFD")).toBe(true);
  });

  it("is false for a decomposed sequence checked against NFC, true against NFD", () => {
    expect(isNfc(NFD_CAFE)).toBe(false);
    expect(isNormalized(NFD_CAFE, "NFD")).toBe(true);
  });

  it("is false for a precomposed character checked against NFD, true against NFC", () => {
    expect(isNfc(NFC_CAFE)).toBe(true);
    expect(isNormalized(NFC_CAFE, "NFD")).toBe(false);
  });

  it("is true for the empty string", () => {
    expect(isNfc("")).toBe(true);
  });
});

describe("isNormalizedChunked / isNfcChunked", () => {
  it("agrees with the whole-string check for simple text split into arbitrary chunks", () => {
    const text = "hello 中文 world\nsecond line";
    expect(isNfcChunked(["hello 中文 world\n", "second line"])).toBe(isNfc(text));
    expect(isNfcChunked([text])).toBe(true);
    expect(isNfcChunked(["h", "e", "l", "l", "o"])).toBe(true);
  });

  it("agrees with the whole-string check for an empty chunk source", () => {
    expect(isNfcChunked([])).toBe(true);
  });

  /**
   * The core hazard this module exists to fix: a combining-mark sequence
   * split exactly at a chunk boundary. Checked two ways — first that a
   * naive "check every chunk independently, AND the results together"
   * implementation gets this *wrong* (a false negative: it reports "already
   * NFC" when the text is not), proving this is a real bug class and not
   * hypothetical; then that `isNfcChunked` gets it right.
   */
  it("detects a combining-mark sequence split exactly at the chunk boundary (the naive per-chunk check misses it)", () => {
    const chunks = ["xxxcafe", "́yyy"]; // splits "e" from its combining acute
    const whole = chunks.join("");
    expect(whole).toBe("xxxcaféyyy");
    expect(isNfc(whole)).toBe(false); // ground truth: not NFC

    const naivePerChunkIndependent = chunks.every((chunk) => isNfc(chunk));
    expect(naivePerChunkIndependent).toBe(true); // the bug: each half looks fine alone

    expect(isNfcChunked(chunks)).toBe(false); // the fix: agrees with ground truth
  });

  it("still detects the split combining sequence across three chunks, not just two", () => {
    const chunks = ["xx", "xcafe", "́yy", "y"];
    expect(chunks.join("")).toBe("xxxcaféyyy");
    expect(isNfcChunked(chunks)).toBe(false);
  });

  it("a combining sequence that is NOT split by a chunk boundary is still correctly read either way", () => {
    // "é" (NFD) kept whole within one chunk.
    expect(isNfcChunked(["xxx" + NFD_CAFE + "yyy"])).toBe(false);
    // Precomposed form kept whole: correctly NFC.
    expect(isNfcChunked(["xxx" + NFC_CAFE + "yyy"])).toBe(true);
  });

  it("a surrogate pair (astral character) split across a chunk boundary is reunited, not misread", () => {
    const rocket = "\u{1F680}"; // single astral code point, one UTF-16 surrogate pair
    const chunks = ["abc" + rocket[0], rocket[1] + "xyz"];
    expect(chunks.join("")).toBe(`abc${rocket}xyz`);
    expect(isNfc(chunks.join(""))).toBe(true); // emoji has no canonical decomposition
    expect(isNfcChunked(chunks)).toBe(true);
  });

  it("works for NFD detection too, not just NFC (genericity over `form`)", () => {
    const chunks = ["xxx" + NFC_CAFE, "yyy"];
    expect(isNormalizedChunked(chunks, "NFD")).toBe(false);
    expect(isNormalizedChunked(["xxx" + NFD_CAFE, "yyy"], "NFD")).toBe(true);
  });

  /**
   * Exhaustive split-invariance: for a fixture containing a combining
   * sequence, split it into two chunks at *every* possible position and
   * confirm `isNfcChunked` always agrees with the plain whole-string
   * check — not just the couple of hand-picked boundary positions above.
   */
  it("agrees with the whole-string check at every possible split point of a combining-sequence fixture", () => {
    const fixture = "ab" + "e" + "́" + "̂" + "cd"; // base + two stacked marks
    const truth = isNfc(fixture);
    for (let i = 0; i <= fixture.length; i++) {
      const chunks = [fixture.slice(0, i), fixture.slice(i)];
      expect(isNfcChunked(chunks), `split at ${i}`).toBe(truth);
    }
  });

  it("agrees with the whole-string check at every split point for an already-NFC fixture too", () => {
    const fixture = "ab" + NFC_CAFE + "cd";
    const truth = isNfc(fixture);
    expect(truth).toBe(true);
    for (let i = 0; i <= fixture.length; i++) {
      const chunks = [fixture.slice(0, i), fixture.slice(i)];
      expect(isNfcChunked(chunks), `split at ${i}`).toBe(truth);
    }
  });

  // --- Hangul conjoining jamo (adversarial-review finding) ---
  //
  // Hangul V (medial vowel, U+1161-U+1175) and T (trailing consonant,
  // U+11A8-U+11C2) jamo compose *algorithmically* with a preceding L /
  // LV under NFC, but their Unicode general category is Lo (letters),
  // not Mark — so a `\p{M}`-only "can this merge with what precedes it?"
  // proxy silently treats a V as a fresh starter, splits an NFD open
  // syllable (L+V) into two individually-innocent-looking halves, and
  // reports it already-NFC. This is not a chunk-boundary edge case: it
  // misfires even on a single-chunk, single-line document, because the
  // faulty split happens inside the checker's own carry logic.

  const NFD_GA = "가"; // 가 decomposed: L + V (open syllable)
  const NFD_GAK = "각"; // 각 decomposed: L + V + T (closed syllable)

  it("detects an NFD Hangul open syllable (L+V) as non-NFC — V jamo is Lo, not \\p{M}", () => {
    expect(NFD_GA.normalize("NFC")).toBe("가"); // fixture premise: composes to 가
    expect(isNfc(NFD_GA)).toBe(false); // ground truth
    expect(isNfcChunked([NFD_GA])).toBe(false); // single chunk, no boundary involved
    expect(isNfcChunked(["hello" + NFD_GA])).toBe(false);
    expect(isNfcChunked([NFD_GA, "\n"])).toBe(false); // CM6-shaped line + line-break chunks
  });

  it("detects an NFD Hangul closed syllable (L+V+T) as non-NFC at every split point", () => {
    const fixture = "x" + NFD_GAK + "y";
    const truth = isNfc(fixture);
    expect(truth).toBe(false);
    for (let i = 0; i <= fixture.length; i++) {
      expect(isNfcChunked([fixture.slice(0, i), fixture.slice(i)]), `split at ${i}`).toBe(truth);
    }
  });

  it("treats precomposed Hangul as NFC, and as non-NFD under the NFD form", () => {
    expect(isNfcChunked(["가각 text"])).toBe(true);
    expect(isNormalizedChunked(["가"], "NFD")).toBe(false);
    expect(isNormalizedChunked([NFD_GA], "NFD")).toBe(true);
  });

  /**
   * The only other non-Mark canonical-composition second element in
   * Unicode 16.0 besides Hangul V/T jamo: U+16D67 KIRAT RAI VOWEL SIGN
   * AAI (category Lo, plane 1), the second half of U+16D68/69/6A's
   * decompositions — found by the planes-0-2 sweep below, which is also
   * what fails loudly (naming the exact code point) if a future Unicode
   * version adds another one. Pinned explicitly here so the sweep failure
   * mode has a worked example next to it.
   */
  it("detects a decomposed Kirat Rai vowel sequence (U+16D63 + U+16D67) as non-NFC", () => {
    const nfd = "\u{16D69}".normalize("NFD");
    expect(nfd).toBe("\u{16D63}\u{16D67}"); // fixture premise
    expect(isNfc(nfd)).toBe(false); // ground truth: recomposes
    expect(isNfcChunked([nfd])).toBe(false);
    expect(isNfcChunked(["x" + nfd, "y"])).toBe(false);
  });

  /**
   * Astral (supplementary-plane) combining marks: U+1109A KAITHI LETTER
   * DDDHA canonically decomposes to U+11099 + U+110BA (a plane-1 Mn
   * nukta) — both astral, two UTF-16 code units each. A chunk boundary at
   * UTF-16 index 3 leaves a lone trailing high surrogate: the carry logic
   * must treat that incomplete code point as uncuttable (its identity —
   * mark or starter — is unknowable until the low surrogate arrives), not
   * flush the base U+11099 and orphan the mark. Found by a
   * plane-0-2-wide verification sweep after the Hangul fix; the committed
   * sweep below now covers the astral planes for the same reason.
   */
  it("does not flush the base away when an astral combining mark is split at its surrogate boundary", () => {
    const nfd = "\u{1109A}".normalize("NFD");
    expect(nfd).toBe("\u{11099}\u{110BA}"); // fixture premise
    expect(nfd.length).toBe(4); // two surrogate pairs
    const truth = isNfc(nfd);
    expect(truth).toBe(false); // recomposes to U+1109A
    for (let i = 1; i < nfd.length; i++) {
      expect(isNfcChunked([nfd.slice(0, i), nfd.slice(i)]), `split at ${i}`).toBe(truth);
    }
  });

  /**
   * Property sweep: for every code point in planes 0-2 (all canonical
   * decompositions in Unicode live there) whose canonical decomposition
   * differs from itself (every precomposed Latin/Greek/Hangul/Kaithi/...
   * character — the complete set of canonical composition pairs appears
   * among these expansions), the chunked check must agree with the
   * whole-string ground truth both as a single chunk and at every 2-chunk
   * split point, including splits that land inside a surrogate pair.
   * Ground truth is computed per fixture, not assumed false: composition
   * exclusions (e.g. U+0958) decompose under NFD but do NOT recompose
   * under NFC, so their expansions genuinely are NFC. Hangul syllables are
   * sampled (every 89th of 11,172 plus the block edges) to keep the suite
   * fast; every other decomposable character is swept exhaustively. This
   * sweep is what pins both adversarial-review-era bugs at once: the
   * Hangul V/T jamo miss and the astral-mark surrogate-split miss.
   */
  it("agrees with ground truth for the NFD expansion of every decomposable character in planes 0-2 (Hangul sampled)", () => {
    const fixtures: string[] = [];
    for (let cp = 0; cp <= 0x2ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // unpaired surrogates
      const ch = String.fromCodePoint(cp);
      const nfd = ch.normalize("NFD");
      if (nfd === ch) continue;
      const isHangul = cp >= 0xac00 && cp <= 0xd7a3;
      if (isHangul && cp % 89 !== 0 && cp !== 0xac00 && cp !== 0xd7a3) continue;
      fixtures.push(nfd);
    }
    expect(fixtures.length).toBeGreaterThan(2000); // premise: the sweep actually swept
    for (const fixture of fixtures) {
      const truth = isNfc(fixture);
      expect(isNfcChunked([fixture]), `single chunk ${JSON.stringify(fixture)}`).toBe(truth);
      for (let i = 1; i < fixture.length; i++) {
        expect(
          isNfcChunked([fixture.slice(0, i), fixture.slice(i)]),
          `${JSON.stringify(fixture)} split at ${i}`,
        ).toBe(truth);
      }
    }
  });
});

describe("countChangedSequences", () => {
  it("is 0 when nothing changes", () => {
    expect(countChangedSequences("hello", "hello")).toBe(0);
  });

  it("counts one changed sequence for a single decomposed character", () => {
    expect(countChangedSequences(NFD_CAFE, NFD_CAFE.normalize("NFC"))).toBe(1);
    expect(NFD_CAFE.normalize("NFC")).toBe(NFC_CAFE);
  });

  it("counts each changed sequence independently among unchanged ones", () => {
    // Two decomposed accented letters among plain ASCII: only the two
    // sequences that actually change should be counted, not the whole
    // string's length or code-point count.
    const original = "a" + "é" + "b" + "í" + "c"; // a é b í c (NFD)
    const normalized = original.normalize("NFC");
    expect(normalized).toBe("aébíc");
    expect(countChangedSequences(original, normalized)).toBe(2);
  });

  it("counts multiple stacked combining marks on one base as a single changed sequence", () => {
    const original = "e" + "́" + "̱"; // e + acute + macron below
    const normalized = original.normalize("NFC");
    expect(normalized).not.toBe(original);
    expect(countChangedSequences(original, normalized)).toBe(1);
  });

  it("is 0 for CJK text normalized either direction (no canonical decomposition to compose/decompose)", () => {
    const text = "中文編碼偵測測試";
    expect(countChangedSequences(text, text.normalize("NFC"))).toBe(0);
    expect(countChangedSequences(text, text.normalize("NFD"))).toBe(0);
  });

  it("counts NFD Hangul per syllable, not via the coarse length-mismatch fallback", () => {
    // Two NFD open syllables (L+V each): with V jamo correctly treated as
    // a sequence extender, both sides split into 2 sequences and the
    // pairwise diff reports 2 — under a \p{M}-only split the NFD side was
    // 4 sequences to the NFC side's 2, forcing the defensive `return 1`
    // and making this count disagree with the representability dialog's
    // own character count (adversarial-review finding).
    const nfd = "\u1100\u1161\u1102\u1161"; // L V L V (NFD of the two syllables below)
    const nfc = nfd.normalize("NFC");
    expect(nfc).toBe("\uAC00\uB098"); // the two precomposed syllables
    expect(countChangedSequences(nfd, nfc)).toBe(2);
    // And the reverse direction (NFC -> NFD).
    expect(countChangedSequences(nfc, nfc.normalize("NFD"))).toBe(2);
    // Closed syllable (L+V+T) still one sequence.
    expect(countChangedSequences("\u1100\u1161\u11A8", "\uAC01")).toBe(1);
  });
});

describe("planNormalization", () => {
  it("reports no change for already-NFC text requesting NFC", () => {
    const plan = planNormalization("hello 中文", "NFC");
    expect(plan.changed).toBe(false);
    expect(plan.changedCount).toBe(0);
    expect(plan.normalized).toBe("hello 中文");
  });

  it("reports the change and count for a decomposed sequence normalized to NFC", () => {
    const plan = planNormalization("xxx" + NFD_CAFE + "yyy", "NFC");
    expect(plan.changed).toBe(true);
    expect(plan.changedCount).toBe(1);
    expect(plan.normalized).toBe("xxx" + NFC_CAFE + "yyy");
    expect(plan.form).toBe("NFC");
  });

  it("reports the change and count for a precomposed character normalized to NFD", () => {
    const plan = planNormalization("xxx" + NFC_CAFE + "yyy", "NFD");
    expect(plan.changed).toBe(true);
    expect(plan.changedCount).toBe(1);
    expect(plan.normalized).toBe("xxx" + NFD_CAFE + "yyy");
  });

  it("reports no change for CJK text under either form (no-op precedent, matches sort/trim's own no-op-dispatches-nothing behavior)", () => {
    const text = "這是一段繁體中文文字，包含標點符號。";
    expect(planNormalization(text, "NFC").changed).toBe(false);
    expect(planNormalization(text, "NFD").changed).toBe(false);
  });

  it("is idempotent: normalizing an already-normalized plan's output again reports no further change", () => {
    const first = planNormalization("xxx" + NFD_CAFE + "yyy", "NFC");
    const second = planNormalization(first.normalized, "NFC");
    expect(second.changed).toBe(false);
  });
});
