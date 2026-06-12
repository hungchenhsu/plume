import { describe, expect, it } from "vitest";
import { filterRecent } from "./quickopen";

const RECENT = [
  "/Users/me/notes/todo.txt",
  "/Users/me/logs/app-2026.log",
  "/Users/me/專案/設定檔.toml",
  "C:\\Users\\me\\readme.md",
];

describe("filterRecent", () => {
  it("returns everything for an empty query", () => {
    expect(filterRecent(RECENT, "")).toEqual(RECENT);
  });

  it("matches case-insensitively on the full path", () => {
    expect(filterRecent(RECENT, "TODO")).toEqual(["/Users/me/notes/todo.txt"]);
    expect(filterRecent(RECENT, "users\\")).toEqual(["C:\\Users\\me\\readme.md"]);
  });

  it("matches non-ASCII path segments", () => {
    expect(filterRecent(RECENT, "設定")).toEqual(["/Users/me/專案/設定檔.toml"]);
  });

  it("returns nothing when no path matches", () => {
    expect(filterRecent(RECENT, "missing")).toEqual([]);
  });

  it("caps results at max", () => {
    expect(filterRecent(RECENT, "", 2)).toEqual(RECENT.slice(0, 2));
  });
});
