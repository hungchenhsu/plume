import { describe, expect, it } from "vitest";
import {
  ENCODING_ALIASES,
  ENCODING_GROUP_ORDER,
  encodingChoiceMatchesQuery,
  encodingChoices,
  filterEncodingChoices,
  groupEncodingChoices,
  groupedEncodingChoices,
  isManualOnlyEncoding,
  MANUAL_ONLY_ENCODINGS,
  matchedEncodingAlias,
  normalizeEncodingQuery,
  streamConvertEncodingChoices,
} from "./encodings";

function key(choice: { value: string; withBom: boolean }): string {
  return `${choice.value} ${choice.withBom}`;
}

describe("groupedEncodingChoices", () => {
  it("covers every encodingChoices() entry exactly once — no omissions, no duplicates", () => {
    const flattened = groupedEncodingChoices().flatMap((g) => g.choices);
    expect(flattened).toHaveLength(encodingChoices().length);

    const flattenedKeys = flattened.map(key).sort();
    const catalogKeys = encodingChoices().map(key).sort();
    expect(flattenedKeys).toEqual(catalogKeys);

    // "exactly one group" — no key repeats within the flattened output.
    expect(new Set(flattenedKeys).size).toBe(flattenedKeys.length);
  });

  it("orders groups per ENCODING_GROUP_ORDER, identically across repeated calls", () => {
    const first = groupedEncodingChoices().map((g) => g.id);
    const second = groupedEncodingChoices().map((g) => g.id);
    expect(first).toEqual(second);

    let cursor = -1;
    for (const id of first) {
      const idx = ENCODING_GROUP_ORDER.indexOf(id);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("buckets the full 27-entry catalog into the 6 documented groups with the expected sizes", () => {
    const groups = groupedEncodingChoices();
    expect(groups.map((g) => g.id)).toEqual([
      "unicode",
      "eastAsian",
      "westernEuropean",
      "centralEuropean",
      "cyrillic",
      "other",
    ]);
    expect(groups.map((g) => g.choices.length)).toEqual([4, 6, 2, 2, 4, 9]);
    expect(groups.reduce((sum, g) => sum + g.choices.length, 0)).toBe(27);
  });

  it("gives each group a non-empty label, distinct from every other group's", () => {
    const labels = groupedEncodingChoices().map((g) => g.label);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("places Cyrillic's windows-1251, ISO-8859-5, and both KOI8 variants together, in catalog order", () => {
    const cyrillic = groupedEncodingChoices().find((g) => g.id === "cyrillic");
    expect(cyrillic?.choices.map((c) => c.value)).toEqual([
      "windows-1251",
      "ISO-8859-5",
      "KOI8-R",
      "KOI8-U",
    ]);
  });

  it("collects the catch-all Other group: Greek/Turkish/Hebrew/Arabic/Baltic/Vietnamese/Thai/Mac Roman", () => {
    const other = groupedEncodingChoices().find((g) => g.id === "other");
    expect(other?.choices.map((c) => c.value)).toEqual([
      "windows-1253",
      "windows-1254",
      "windows-1255",
      "windows-1256",
      "windows-1257",
      "windows-1258",
      "ISO-8859-7",
      "windows-874",
      "macintosh",
    ]);
  });
});

describe("groupEncodingChoices", () => {
  it("omits a group entirely rather than emitting it empty, for a filtered choice list", () => {
    // streamConvertEncodingChoices() drops UTF-16LE/BE but keeps both UTF-8
    // variants, so Unicode survives with fewer members — every group that
    // *is* present must still be non-empty.
    const groups = groupEncodingChoices(streamConvertEncodingChoices());
    for (const group of groups) expect(group.choices.length).toBeGreaterThan(0);
    const unicode = groups.find((g) => g.id === "unicode");
    expect(unicode?.choices.map((c) => c.value)).toEqual(["UTF-8", "UTF-8"]);
    expect(groups.some((g) => g.choices.some((c) => c.value.startsWith("UTF-16")))).toBe(false);
  });

  it("drops entries with no group instead of inventing one for them", () => {
    const keepPseudo = { label: "Keep current encoding", value: "keep", withBom: false };
    const groups = groupEncodingChoices([keepPseudo, ...encodingChoices()]);
    const total = groups.reduce((sum, g) => sum + g.choices.length, 0);
    expect(total).toBe(encodingChoices().length);
    expect(groups.some((g) => g.choices.some((c) => c.value === "keep"))).toBe(false);
  });
});

// ROADMAP.md v0.5 Track E3: which catalog values chardetng's statistical
// guess can never itself produce, verified against chardetng 0.1.17's own
// README (see MANUAL_ONLY_ENCODINGS's doc comment in encodings.ts for the
// citation) rather than assumed from encoding age or byte width.
describe("isManualOnlyEncoding", () => {
  it("is exactly the four verified-undetectable values — no more, no fewer", () => {
    expect([...MANUAL_ONLY_ENCODINGS].sort()).toEqual([
      "ISO-8859-15",
      "KOI8-R",
      "gb18030",
      "macintosh",
    ]);
  });

  it("flags gb18030, ISO-8859-15, KOI8-R and macintosh", () => {
    expect(isManualOnlyEncoding("gb18030")).toBe(true);
    expect(isManualOnlyEncoding("ISO-8859-15")).toBe(true);
    expect(isManualOnlyEncoding("KOI8-R")).toBe(true);
    expect(isManualOnlyEncoding("macintosh")).toBe(true);
  });

  it("does not flag Unicode encodings — UTF-8 and UTF-16 are detected (via chardetng or the BOM layer)", () => {
    expect(isManualOnlyEncoding("UTF-8")).toBe(false);
    expect(isManualOnlyEncoding("UTF-16LE")).toBe(false);
    expect(isManualOnlyEncoding("UTF-16BE")).toBe(false);
  });

  it("does not flag the other East Asian encodings — GBK, Big5, Shift_JIS, EUC-JP, EUC-KR are genuine chardetng targets", () => {
    for (const value of ["GBK", "Big5", "Shift_JIS", "EUC-JP", "EUC-KR"]) {
      expect(isManualOnlyEncoding(value)).toBe(false);
    }
  });

  it("does not flag any windows-125x/874 member, even the low-accuracy ones (windows-1257, windows-874)", () => {
    for (const value of [
      "windows-1250",
      "windows-1251",
      "windows-1252",
      "windows-1253",
      "windows-1254",
      "windows-1255",
      "windows-1256",
      "windows-1257",
      "windows-1258",
      "windows-874",
    ]) {
      expect(isManualOnlyEncoding(value)).toBe(false);
    }
  });

  it("does not flag the other detected ISO-8859 members or KOI8-U", () => {
    expect(isManualOnlyEncoding("ISO-8859-2")).toBe(false);
    expect(isManualOnlyEncoding("ISO-8859-5")).toBe(false);
    expect(isManualOnlyEncoding("ISO-8859-7")).toBe(false);
    expect(isManualOnlyEncoding("KOI8-U")).toBe(false);
  });

  it("returns false for a value outside the catalog entirely, rather than throwing", () => {
    expect(isManualOnlyEncoding("not-a-real-encoding")).toBe(false);
  });

  it("every MANUAL_ONLY_ENCODINGS entry is a real value in the 27-entry catalog", () => {
    const catalogValues = new Set(encodingChoices().map((c) => c.value));
    for (const value of MANUAL_ONLY_ENCODINGS) {
      expect(catalogValues.has(value)).toBe(true);
    }
  });
});

// ROADMAP.md v0.7 Track C encoding-picker alias search: investigation found
// the picker had no filter mechanism at all (popup.ts's showMenu is a plain
// click list), so this is new, not an extension of existing matching. Every
// alias asserted against here is cited in ENCODING_ALIASES's own doc
// comment (encoding_rs 0.8.35's generated WHATWG label table, or Microsoft's
// Code Page Identifiers reference for the cp93x/cp95x/"ansi" entries).
describe("normalizeEncodingQuery", () => {
  it("lowercases", () => {
    expect(normalizeEncodingQuery("LATIN1")).toBe("latin1");
  });

  it("strips hyphens, underscores, and whitespace", () => {
    expect(normalizeEncodingQuery("ISO-8859-1")).toBe("iso88591");
    expect(normalizeEncodingQuery("ks_c_5601-1987")).toBe("ksc56011987");
    expect(normalizeEncodingQuery("windows 1252")).toBe("windows1252");
  });

  it("makes differently-punctuated/-cased spellings of the same name compare equal", () => {
    const spellings = ["Latin-1", "latin_1", "LATIN 1", "latin1"];
    const normalized = new Set(spellings.map(normalizeEncodingQuery));
    expect(normalized.size).toBe(1);
  });

  it("leaves colons alone (deliberately narrow — see doc comment)", () => {
    expect(normalizeEncodingQuery("iso_8859-1:1987")).toBe("iso88591:1987");
  });

  it("empty string normalizes to empty string", () => {
    expect(normalizeEncodingQuery("")).toBe("");
  });
});

describe("ENCODING_ALIASES", () => {
  it("every key is a real value in the 27-entry catalog", () => {
    const catalogValues = new Set(encodingChoices().map((c) => c.value));
    for (const value of Object.keys(ENCODING_ALIASES)) {
      expect(catalogValues.has(value)).toBe(true);
    }
  });

  it("has no empty alias lists (an absent key, not an empty array, means 'no aliases')", () => {
    for (const aliases of Object.values(ENCODING_ALIASES)) {
      expect(aliases.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate alias within a single value's list", () => {
    for (const [value, aliases] of Object.entries(ENCODING_ALIASES)) {
      expect(new Set(aliases).size, `duplicate alias for ${value}`).toBe(aliases.length);
    }
  });
});

describe("encodingChoiceMatchesQuery / filterEncodingChoices", () => {
  it("an empty query matches every choice", () => {
    expect(filterEncodingChoices(encodingChoices(), "")).toHaveLength(encodingChoices().length);
  });

  it("matches by canonical value substring even when the label differs", () => {
    const choice = { label: "Something else entirely", value: "GBK", withBom: false };
    expect(encodingChoiceMatchesQuery(choice, "GBK")).toBe(true);
  });

  it("matches by label substring, case-insensitively", () => {
    const results = filterEncodingChoices(encodingChoices(), "traditional chinese");
    expect(results.map((c) => c.value)).toEqual(["Big5"]);
  });

  it("latin1 matches windows-1252 (WHATWG's own latin1->windows-1252 mapping, not ISO-8859-1)", () => {
    const results = filterEncodingChoices(encodingChoices(), "latin1");
    expect(results.map((c) => c.value)).toEqual(["windows-1252"]);
  });

  it("cp950 matches Big5 (Microsoft code page 950)", () => {
    const results = filterEncodingChoices(encodingChoices(), "cp950");
    expect(results.map((c) => c.value)).toEqual(["Big5"]);
  });

  it("cp932/ms932 both match Shift_JIS (Microsoft code page 932)", () => {
    expect(filterEncodingChoices(encodingChoices(), "cp932").map((c) => c.value)).toEqual([
      "Shift_JIS",
    ]);
    expect(filterEncodingChoices(encodingChoices(), "ms932").map((c) => c.value)).toEqual([
      "Shift_JIS",
    ]);
  });

  it("cp936 matches GBK (Microsoft code page 936)", () => {
    expect(filterEncodingChoices(encodingChoices(), "cp936").map((c) => c.value)).toEqual(["GBK"]);
  });

  it("cp949 matches EUC-KR (Microsoft code page 949)", () => {
    expect(filterEncodingChoices(encodingChoices(), "cp949").map((c) => c.value)).toEqual([
      "EUC-KR",
    ]);
  });

  it("ansi surfaces every regional system-code-page candidate (locale-dependent by design)", () => {
    // Not a single best-effort mapping: "ANSI" means the Windows system
    // code page, which differs per locale (cp1252 Western, cp950 Big5,
    // cp932 Shift_JIS, cp936 GBK, cp949 EUC-KR). The picker surfaces all
    // five and the user picks — see ENCODING_ALIASES doc comment.
    expect(filterEncodingChoices(encodingChoices(), "ansi").map((c) => c.value)).toEqual([
      "Big5",
      "GBK",
      "Shift_JIS",
      "EUC-KR",
      "windows-1252",
    ]);
  });

  it("ucs-2 matches UTF-16LE", () => {
    expect(filterEncodingChoices(encodingChoices(), "ucs-2").map((c) => c.value)).toEqual([
      "UTF-16LE",
    ]);
  });

  it("gb2312 matches GBK, not gb18030 (encoding_rs's own for_label table, not the newer superset)", () => {
    expect(filterEncodingChoices(encodingChoices(), "gb2312").map((c) => c.value)).toEqual(["GBK"]);
  });

  it("matches case-insensitively and with hyphens/underscores/spaces ignored, identically across spellings", () => {
    const spellings = ["CP1252", "cp-1252", "cp_1252", "cp 1252"];
    for (const spelling of spellings) {
      expect(filterEncodingChoices(encodingChoices(), spelling).map((c) => c.value)).toEqual([
        "windows-1252",
      ]);
    }
  });

  it("a query with no matching label/value/alias returns an empty list — the no-match fallback", () => {
    expect(filterEncodingChoices(encodingChoices(), "not-a-real-encoding-name")).toEqual([]);
  });
});

describe("matchedEncodingAlias", () => {
  it("returns the matched alias when the hit came from an alias, not the label/value", () => {
    expect(
      matchedEncodingAlias({ label: "Big5 (Traditional Chinese)", value: "Big5", withBom: false }, "cp950"),
    ).toBe("cp950");
  });

  it("returns undefined when the label itself already matches — no alias needed to explain the hit", () => {
    expect(
      matchedEncodingAlias({ label: "Big5 (Traditional Chinese)", value: "Big5", withBom: false }, "big5"),
    ).toBeUndefined();
  });

  it("returns undefined when the canonical value itself already matches", () => {
    expect(
      matchedEncodingAlias({ label: "Something else", value: "GBK", withBom: false }, "gbk"),
    ).toBeUndefined();
  });

  it("returns undefined for an empty query", () => {
    expect(
      matchedEncodingAlias({ label: "Big5 (Traditional Chinese)", value: "Big5", withBom: false }, ""),
    ).toBeUndefined();
  });

  it("returns undefined when nothing matches at all", () => {
    expect(
      matchedEncodingAlias(
        { label: "Big5 (Traditional Chinese)", value: "Big5", withBom: false },
        "not-a-real-encoding-name",
      ),
    ).toBeUndefined();
  });
});
