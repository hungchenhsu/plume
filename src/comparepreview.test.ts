import { describe, expect, it } from "vitest";
import { pickDefaultCompareB } from "./comparepreview";
import { reopenEncodingChoices } from "./encodings";

describe("pickDefaultCompareB", () => {
  it("picks the first choice whose value differs from A", () => {
    const choices = reopenEncodingChoices();
    const result = pickDefaultCompareB(choices, choices[0].value);
    expect(result).not.toBe(choices[0].value);
    expect(choices.some((c) => c.value === result)).toBe(true);
  });

  it("picks the first choice outright when A matches nothing in the list", () => {
    const choices = reopenEncodingChoices();
    expect(pickDefaultCompareB(choices, "Not-A-Real-Encoding")).toBe(choices[0].value);
  });

  it("falls back to A itself when choices is empty", () => {
    expect(pickDefaultCompareB([], "UTF-8")).toBe("UTF-8");
  });

  it("skips past a value that appears more than once at the front of the list", () => {
    const choices = [
      { label: "UTF-8", value: "UTF-8", withBom: false },
      { label: "UTF-8 BOM", value: "UTF-8", withBom: true },
      { label: "Big5", value: "Big5", withBom: false },
    ];
    expect(pickDefaultCompareB(choices, "UTF-8")).toBe("Big5");
  });

  it("never returns the same value as A when at least one alternative exists", () => {
    const choices = reopenEncodingChoices();
    for (const choice of choices) {
      expect(pickDefaultCompareB(choices, choice.value)).not.toBe(choice.value);
    }
  });
});
