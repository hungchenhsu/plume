import { describe, expect, it } from "vitest";
import {
  accumulateChunk,
  countTextStats,
  createTextStatsAccumulator,
  finishRangeTextStats,
  finishTextStats,
} from "./textstats";

describe("countTextStats: basic ASCII", () => {
  it("counts an empty string as 0 chars, 0 words, 1 line", () => {
    expect(countTextStats("")).toEqual({ chars: 0, words: 0, lines: 1 });
  });

  it("counts a simple two-word sentence", () => {
    expect(countTextStats("hello world")).toEqual({ chars: 11, words: 2, lines: 1 });
  });

  it("does not let punctuation or repeated spaces merge or split words", () => {
    // "hello,  world!!" -> words: "hello", "world"; punctuation/space runs
    // between them never count as their own word.
    const text = "hello,  world!!";
    expect(countTextStats(text)).toEqual({ chars: text.length, words: 2, lines: 1 });
  });

  it("treats letters and digits as the same word class (no split between them)", () => {
    expect(countTextStats("abc123 456")).toEqual({ chars: 10, words: 2, lines: 1 });
  });

  it("counts a whitespace-only string as 0 words", () => {
    const text = "   \t  ";
    expect(countTextStats(text)).toEqual({ chars: text.length, words: 0, lines: 1 });
  });
});

describe("countTextStats: CJK-aware word counting", () => {
  it("counts each CJK Unified Ideograph as its own word", () => {
    const text = "你好世界"; // 4 characters
    expect(countTextStats(text)).toEqual({ chars: 4, words: 4, lines: 1 });
  });

  it("counts a CJK Unified Ideographs Extension A character as a word", () => {
    // U+3400 is the first code point of Extension A.
    const text = "㐀㐁";
    expect(countTextStats(text)).toEqual({ chars: 2, words: 2, lines: 1 });
  });

  it("counts each Hiragana character as its own word", () => {
    const text = "こんにちは"; // 5 hiragana characters
    expect(countTextStats(text)).toEqual({ chars: 5, words: 5, lines: 1 });
  });

  it("counts each Katakana character as its own word", () => {
    const text = "コンピュータ"; // 6 katakana characters
    expect(countTextStats(text)).toEqual({ chars: 6, words: 6, lines: 1 });
  });

  it("counts each Hangul syllable as its own word", () => {
    const text = "안녕하세요"; // 5 Hangul syllables
    expect(countTextStats(text)).toEqual({ chars: 5, words: 5, lines: 1 });
  });

  it("does not merge a CJK character with an adjacent non-CJK word run", () => {
    // "hello" + "你" + "好" + "world" -> 4 words, not 2 (which a naive
    // \p{L}\p{N} run-based count would give, since CJK ideographs are
    // also category L).
    const text = "hello你好world";
    expect(countTextStats(text)).toEqual({ chars: 12, words: 4, lines: 1 });
  });

  it("mixes CJK, Hangul, Hiragana, and a trailing digit run correctly", () => {
    // "Hello"(1) "你"(2) "好"(3) "안"(4) "녕"(5) "こ"(6) "ん"(7) "123"(8)
    const text = "Hello你好안녕こん123";
    expect(countTextStats(text)).toEqual({ chars: 5 + 2 + 2 + 2 + 3, words: 8, lines: 1 });
  });
});

describe("countTextStats: non-ASCII Latin and other Unicode letters", () => {
  it("counts accented Latin letters as word characters (fallback \\p{L} path)", () => {
    const text = "café münchen";
    expect(countTextStats(text)).toEqual({ chars: 12, words: 2, lines: 1 });
  });

  it("counts Cyrillic and Greek runs as words too", () => {
    const text = "привет κόσμος";
    expect(countTextStats(text)).toEqual({ chars: text.length, words: 2, lines: 1 });
  });
});

describe("countTextStats: emoji / supplementary-plane code points", () => {
  it("counts a single emoji (surrogate pair) as one character, not two", () => {
    expect(countTextStats("😀")).toEqual({ chars: 1, words: 0, lines: 1 });
  });

  it("does not count an emoji as a word, and it still breaks a word run", () => {
    // "a" + emoji + "b": the emoji is category So (symbol), not L/N, so it
    // is neither CJK nor a word char, and ends any run in progress.
    const text = "a😀b";
    expect(countTextStats(text)).toEqual({ chars: 3, words: 2, lines: 1 });
  });

  it("counts a run of several emoji as that many characters and 0 words", () => {
    const text = "😀😁😂";
    expect(countTextStats(text)).toEqual({ chars: 3, words: 0, lines: 1 });
  });
});

describe("countTextStats: line counting", () => {
  it("counts lines with no trailing newline", () => {
    expect(countTextStats("a\nb\nc")).toEqual({ chars: 5, words: 3, lines: 3 });
  });

  it("counts one further (empty) line for a trailing newline, matching CM6's Text.lines", () => {
    expect(countTextStats("a\nb\nc\n")).toEqual({ chars: 6, words: 3, lines: 4 });
  });

  it("counts blank lines in the middle", () => {
    expect(countTextStats("a\n\nb")).toEqual({ chars: 4, words: 2, lines: 3 });
  });

  it("mixes tabs and newlines correctly for both words and lines", () => {
    // "a" word1, tab ends it, "b" word2, newline, "c" word3.
    expect(countTextStats("a\tb\nc")).toEqual({ chars: 5, words: 3, lines: 2 });
  });
});

describe("streaming accumulation: chunk-boundary correctness", () => {
  it("does not double-count a word split across two chunks", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "hel");
    accumulateChunk(acc, "lo");
    expect(finishTextStats(acc)).toEqual({ chars: 5, words: 1, lines: 1 });
  });

  it("does not double-count a word split across three chunks", () => {
    const acc = createTextStatsAccumulator();
    for (const chunk of ["h", "el", "l", "o"]) accumulateChunk(acc, chunk);
    expect(finishTextStats(acc)).toEqual({ chars: 5, words: 1, lines: 1 });
  });

  it("starts a new word correctly when a chunk boundary lands right at a word start", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "hello ");
    accumulateChunk(acc, "world");
    expect(finishTextStats(acc)).toEqual({ chars: 11, words: 2, lines: 1 });
  });

  it("does not merge a CJK character adjacent to Latin text across a chunk boundary", () => {
    // "ab你" | "好cd" split mid-CJK-run: still ab(1) 你(2) 好(3) cd(4).
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "ab你");
    accumulateChunk(acc, "好cd");
    expect(finishTextStats(acc)).toEqual({ chars: 6, words: 4, lines: 1 });
  });

  it("reassembles an emoji surrogate pair split exactly at the chunk boundary", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "a\uD83D"); // "a" + emoji high surrogate half
    accumulateChunk(acc, "\uDE00b"); // emoji low surrogate half + "b"
    // Reassembled emoji is 1 char (not 2 dangling surrogates); "a" and "b"
    // are two separate words since the emoji breaks the run between them.
    expect(finishTextStats(acc)).toEqual({ chars: 3, words: 2, lines: 1 });
  });

  it("reassembles a surrogate pair even when held across more than one empty chunk", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "\uD83D");
    accumulateChunk(acc, "");
    accumulateChunk(acc, "\uDE00");
    expect(finishTextStats(acc)).toEqual({ chars: 1, words: 0, lines: 1 });
  });

  it("counts a lone unpaired high surrogate at the very end of input as one character", () => {
    // Defensive/degradation case: nothing ever supplies the low surrogate.
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "x\uD83D");
    expect(finishTextStats(acc)).toEqual({ chars: 2, words: 1, lines: 1 });
  });

  it("counts a lone unpaired low surrogate at the very start of input as one character", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "\uDE00x");
    expect(finishTextStats(acc)).toEqual({ chars: 2, words: 1, lines: 1 });
  });

  it("does not double-count a newline split from its surrounding content across chunks", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "aa");
    accumulateChunk(acc, "\n");
    accumulateChunk(acc, "bb");
    expect(finishTextStats(acc)).toEqual({ chars: 5, words: 2, lines: 2 });
  });

  it("agrees with the non-streaming countTextStats for the same logical text", () => {
    const whole = "Hello, 世界! café 😀\nsecond line\nthird";
    const acc = createTextStatsAccumulator();
    for (const chunk of ["Hello, ", "世", "界! caf", "é 😀\nsec", "ond line\nthird"]) {
      accumulateChunk(acc, chunk);
    }
    expect(finishTextStats(acc)).toEqual(countTextStats(whole));
  });
});

describe("finishRangeTextStats: selection-range trailing-newline convention", () => {
  it("does not count a range's own trailing newline as opening a further line", () => {
    // Selecting exactly "AAA\n" (through the newline, but none of the next
    // line) should span 1 line, not 2 — mirrors lineSpanForSelection's
    // to-1 convention (issue #99).
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "AAA\n");
    expect(finishTextStats(acc)).toEqual({ chars: 4, words: 1, lines: 2 });
    expect(finishRangeTextStats(acc)).toEqual({ chars: 4, words: 1, lines: 1 });
  });

  it("counts the full extra line when a range ends mid-line after a newline", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "AAA\nB");
    expect(finishRangeTextStats(acc)).toEqual({ chars: 5, words: 2, lines: 2 });
    // No trailing newline: both finish functions agree here.
    expect(finishRangeTextStats(acc)).toEqual(finishTextStats(acc));
  });

  it("subtracts only one line even when the range contains multiple newlines and ends on one", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "AAA\nBBB\n");
    expect(finishTextStats(acc)).toEqual({ chars: 8, words: 2, lines: 3 });
    expect(finishRangeTextStats(acc)).toEqual({ chars: 8, words: 2, lines: 2 });
  });

  it("never goes below 1 line for a range that is only a single trailing newline", () => {
    const acc = createTextStatsAccumulator();
    accumulateChunk(acc, "\n");
    expect(finishRangeTextStats(acc)).toEqual({ chars: 1, words: 0, lines: 1 });
  });
});
