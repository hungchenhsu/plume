import { describe, expect, it } from "vitest";
import { convertiblePaths, countByStatus, parseExtensions } from "./batchconvert";
import type { BatchEntry } from "./ipc";

describe("parseExtensions", () => {
  it("splits on commas and trims whitespace", () => {
    expect(parseExtensions(" txt, md ,csv")).toEqual(["txt", "md", "csv"]);
  });

  it("lowercases and strips a leading dot", () => {
    expect(parseExtensions(".TXT, .Md")).toEqual(["txt", "md"]);
  });

  it("strips multiple leading dots", () => {
    expect(parseExtensions("..txt")).toEqual(["txt"]);
  });

  it("drops empty segments from stray commas", () => {
    expect(parseExtensions("txt,,md,")).toEqual(["txt", "md"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseExtensions("txt,TXT,txt")).toEqual(["txt"]);
  });

  it("returns an empty array for blank input (matches every file)", () => {
    expect(parseExtensions("")).toEqual([]);
    expect(parseExtensions("   ")).toEqual([]);
    expect(parseExtensions(",,,")).toEqual([]);
  });
});

function entry(status: string, path = `/f-${status}.txt`, detected = "Big5"): BatchEntry {
  return { path, detected, status, lineEnding: null };
}

describe("countByStatus", () => {
  it("tallies every known status independently", () => {
    const entries = [
      entry("convertible"),
      entry("convertible"),
      entry("alreadyTarget"),
      entry("lossy"),
      entry("undecodable"),
      entry("tooLarge"),
    ];
    expect(countByStatus(entries)).toEqual({
      convertible: 2,
      alreadyTarget: 1,
      lossy: 1,
      undecodable: 1,
      tooLarge: 1,
    });
  });

  it("returns all zeros for an empty report", () => {
    expect(countByStatus([])).toEqual({
      convertible: 0,
      alreadyTarget: 0,
      lossy: 0,
      undecodable: 0,
      tooLarge: 0,
    });
  });

  it("ignores an unrecognized status rather than throwing", () => {
    expect(countByStatus([entry("somethingNew")])).toEqual({
      convertible: 0,
      alreadyTarget: 0,
      lossy: 0,
      undecodable: 0,
      tooLarge: 0,
    });
  });
});

describe("convertiblePaths", () => {
  it("returns only the paths of convertible entries, in report order", () => {
    const entries = [
      entry("convertible", "/a.txt"),
      entry("alreadyTarget", "/b.txt"),
      entry("convertible", "/c.txt"),
      entry("lossy", "/d.txt"),
    ];
    expect(convertiblePaths(entries)).toEqual(["/a.txt", "/c.txt"]);
  });

  it("returns an empty array when nothing is convertible", () => {
    expect(convertiblePaths([entry("alreadyTarget"), entry("tooLarge")])).toEqual([]);
  });

  it("returns an empty array for an empty report", () => {
    expect(convertiblePaths([])).toEqual([]);
  });
});
