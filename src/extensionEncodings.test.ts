import { describe, expect, it } from "vitest";
import {
  extensionOf,
  lookupExtensionEncoding,
  normalizeExtension,
  normalizeTable,
} from "./extensionEncodings";

describe("normalizeExtension", () => {
  it("lowercases and trims", () => {
    expect(normalizeExtension("  TXT ")).toBe("txt");
  });

  it("strips leading dots and glob prefixes", () => {
    expect(normalizeExtension(".txt")).toBe("txt");
    expect(normalizeExtension("*.txt")).toBe("txt");
    expect(normalizeExtension("..txt")).toBe("txt");
  });

  it("rejects empty and dot-only input", () => {
    expect(normalizeExtension("")).toBeNull();
    expect(normalizeExtension("   ")).toBeNull();
    expect(normalizeExtension(".")).toBeNull();
    expect(normalizeExtension("*.")).toBeNull();
  });

  it("rejects inner whitespace, dots and path separators", () => {
    expect(normalizeExtension("tar.gz")).toBeNull();
    expect(normalizeExtension("t xt")).toBeNull();
    expect(normalizeExtension("a/b")).toBeNull();
    expect(normalizeExtension("a\\b")).toBeNull();
  });
});

describe("normalizeTable", () => {
  it("normalizes extensions and keeps encodings", () => {
    expect(
      normalizeTable([
        { extension: ".TXT", encoding: "Big5" },
        { extension: "log", encoding: "UTF-8" },
      ]),
    ).toEqual([
      ["txt", "Big5"],
      ["log", "UTF-8"],
    ]);
  });

  it("drops rows with invalid extensions or empty encodings", () => {
    expect(
      normalizeTable([
        { extension: "", encoding: "Big5" },
        { extension: "txt", encoding: "" },
        { extension: "csv", encoding: "Big5" },
      ]),
    ).toEqual([["csv", "Big5"]]);
  });

  it("dedupes duplicate extensions with the last row winning", () => {
    expect(
      normalizeTable([
        { extension: "txt", encoding: "Big5" },
        { extension: "log", encoding: "UTF-8" },
        { extension: ".TXT", encoding: "Shift_JIS" },
      ]),
    ).toEqual([
      ["log", "UTF-8"],
      ["txt", "Shift_JIS"],
    ]);
  });

  it("returns an empty table for no usable rows", () => {
    expect(normalizeTable([])).toEqual([]);
    expect(normalizeTable([{ extension: ".", encoding: "Big5" }])).toEqual([]);
  });
});

describe("extensionOf", () => {
  it("extracts the lowercase extension", () => {
    expect(extensionOf("/tmp/notes.TXT")).toBe("txt");
    expect(extensionOf("C:\\docs\\readme.md")).toBe("md");
  });

  it("uses only the last dot segment", () => {
    expect(extensionOf("/tmp/archive.tar.gz")).toBe("gz");
  });

  it("returns null when there is no usable extension", () => {
    expect(extensionOf("/tmp/Makefile")).toBeNull();
    expect(extensionOf("/tmp/.gitignore")).toBeNull();
    expect(extensionOf("/tmp/trailing.")).toBeNull();
    // A dot in a directory name is not a file extension.
    expect(extensionOf("/tmp/v1.2/README")).toBeNull();
  });
});

describe("lookupExtensionEncoding", () => {
  const table: [string, string][] = [
    ["txt", "Big5"],
    ["log", "UTF-8"],
  ];

  it("finds the mapping for a path's extension, case-insensitively", () => {
    expect(lookupExtensionEncoding(table, "/tmp/a.txt")).toBe("Big5");
    expect(lookupExtensionEncoding(table, "/tmp/A.TXT")).toBe("Big5");
    expect(lookupExtensionEncoding(table, "C:\\logs\\app.log")).toBe("UTF-8");
  });

  it("returns undefined for unmapped or extension-less paths", () => {
    expect(lookupExtensionEncoding(table, "/tmp/a.csv")).toBeUndefined();
    expect(lookupExtensionEncoding(table, "/tmp/Makefile")).toBeUndefined();
    expect(lookupExtensionEncoding([], "/tmp/a.txt")).toBeUndefined();
  });
});
