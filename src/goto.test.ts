import { describe, expect, it } from "vitest";
import { parseGoToInput } from "./goto";

describe("parseGoToInput", () => {
  it("parses a bare line number, with no column (line-start, pre-existing behavior)", () => {
    expect(parseGoToInput("123")).toEqual({ line: 123, column: null });
  });

  it("parses line:column", () => {
    expect(parseGoToInput("123:45")).toEqual({ line: 123, column: 45 });
  });

  it("treats a trailing bare colon the same as no column at all", () => {
    expect(parseGoToInput("123:")).toEqual({ line: 123, column: null });
  });

  it("rejects a colon with no leading line", () => {
    expect(parseGoToInput(":45")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseGoToInput("")).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    expect(parseGoToInput("   ")).toBeNull();
  });

  it("rejects non-numeric garbage", () => {
    expect(parseGoToInput("abc")).toBeNull();
  });

  it("rejects garbage mixed with digits", () => {
    expect(parseGoToInput("12a:45")).toBeNull();
    expect(parseGoToInput("12:4a")).toBeNull();
  });

  it("rejects a space between the colon and the column", () => {
    expect(parseGoToInput("123: 45")).toBeNull();
  });

  it("accepts a very large but still-finite line number, unclamped (the editor clamps it)", () => {
    expect(parseGoToInput("99999999999999")).toEqual({
      line: 99999999999999,
      column: null,
    });
  });

  it("rejects a line number so large it overflows to Infinity", () => {
    expect(parseGoToInput("9".repeat(400))).toBeNull();
  });

  it("rejects a column so large it overflows to Infinity", () => {
    expect(parseGoToInput(`12:${"9".repeat(400)}`)).toBeNull();
  });

  it("rejects a zero line", () => {
    expect(parseGoToInput("0")).toBeNull();
  });

  it("rejects a zero column", () => {
    expect(parseGoToInput("12:0")).toBeNull();
  });

  it("rejects a negative line", () => {
    expect(parseGoToInput("-5")).toBeNull();
  });

  it("rejects a negative column", () => {
    expect(parseGoToInput("12:-5")).toBeNull();
  });

  it("trims surrounding whitespace around an otherwise-valid input", () => {
    expect(parseGoToInput("  123:45  ")).toEqual({ line: 123, column: 45 });
  });
});
