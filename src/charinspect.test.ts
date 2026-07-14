import { describe, expect, it } from "vitest";
import { formatCharInspect } from "./charinspect";

describe("formatCharInspect", () => {
  it("titles the card after the character's code point", () => {
    const model = formatCharInspect("中", "UTF-8", "E4 B8 AD", null);
    expect(model.title).toBe("Character U+4E2D");
  });

  it("reports the character, code point, and UTF-8 bytes as rows when the save encoding is UTF-8", () => {
    const model = formatCharInspect("中", "UTF-8", "E4 B8 AD", null);
    expect(model.rows).toEqual([
      { label: "Character", value: "中" },
      { label: "Code Point", value: "U+4E2D" },
      { label: "UTF-8 Bytes", value: "E4 B8 AD" },
    ]);
  });

  it("adds a fourth row for the save encoding's bytes when it differs from UTF-8", () => {
    const model = formatCharInspect("中", "Big5", "E4 B8 AD", {
      hex: "A4 A4",
      lossy: false,
    });
    expect(model.rows).toContainEqual({
      label: "Big5 Bytes",
      value: "A4 A4",
    });
    expect(model.rows.find((r) => r.warn)).toBeUndefined();
  });

  it("shows a 'cannot be represented' message instead of bytes when the save encoding can't represent the character", () => {
    const model = formatCharInspect("é", "Big5", "C3 A9", {
      hex: "",
      lossy: true,
    });
    const targetRow = model.rows.find((r) => r.label === "Big5 Bytes");
    expect(targetRow).toEqual({
      label: "Big5 Bytes",
      value: "Cannot be represented in Big5",
      warn: true,
    });
  });

  it("assembles a surrogate-pair character's code point correctly", () => {
    const model = formatCharInspect("\u{1F600}", "UTF-8", "F0 9F 98 80", null);
    expect(model.title).toBe("Character U+1F600");
    expect(model.rows).toContainEqual({
      label: "Code Point",
      value: "U+1F600",
    });
  });
});
