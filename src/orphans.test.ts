import { describe, expect, it } from "vitest";
import { orphanBackups } from "./orphans";

describe("orphanBackups", () => {
  const all = ["bk-1.txt", "bk-2.txt", "bk-3.txt"];

  it("returns everything when nothing is referenced", () => {
    expect(orphanBackups([], all)).toEqual(all);
  });

  it("returns nothing when everything is referenced", () => {
    expect(
      orphanBackups(["bk-1.txt", "bk-2.txt", "bk-3.txt"], all),
    ).toEqual([]);
  });

  it("returns the set difference when partially referenced", () => {
    expect(orphanBackups(["bk-2.txt"], all)).toEqual(["bk-1.txt", "bk-3.txt"]);
  });

  it("returns nothing when there are no backups at all", () => {
    expect(orphanBackups(["bk-1.txt"], [])).toEqual([]);
  });

  it("ignores null and undefined entries in referenced", () => {
    expect(orphanBackups([null, undefined, "bk-2.txt"], all)).toEqual([
      "bk-1.txt",
      "bk-3.txt",
    ]);
  });

  it("preserves the order of all", () => {
    expect(orphanBackups(["bk-3.txt"], all)).toEqual(["bk-1.txt", "bk-2.txt"]);
  });
});
