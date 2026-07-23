import { describe, expect, it } from "vitest";
import { SearchHistory, type HistoryStorage } from "./searchhistory";

/** In-memory stand-in for `localStorage` used across most tests. */
function makeMemoryStorage(): HistoryStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** Storage that always throws — simulates a disabled/quota-exceeded backend. */
function makeFailingStorage(): HistoryStorage {
  return {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
}

describe("SearchHistory", () => {
  it("keeps most-recently-used order, newest first", () => {
    const history = new SearchHistory(null);
    history.pushFind("alpha");
    history.pushFind("beta");
    history.pushFind("gamma");
    expect(history.findTerms()).toEqual(["gamma", "beta", "alpha"]);
  });

  it("dedupes a repeated term by moving it to the front instead of duplicating", () => {
    const history = new SearchHistory(null);
    history.pushFind("alpha");
    history.pushFind("beta");
    history.pushFind("alpha");
    expect(history.findTerms()).toEqual(["alpha", "beta"]);
  });

  it("caps the list at 20 entries, dropping the oldest", () => {
    const history = new SearchHistory(null);
    for (let i = 0; i < 25; i++) {
      history.pushFind(`term-${i}`);
    }
    const terms = history.findTerms();
    expect(terms).toHaveLength(20);
    // Most recent (term-24) first, oldest surviving is term-5; term-0..4 fell off.
    expect(terms[0]).toBe("term-24");
    expect(terms[terms.length - 1]).toBe("term-5");
    expect(terms).not.toContain("term-4");
  });

  it("does not record an empty string", () => {
    const history = new SearchHistory(null);
    history.pushFind("alpha");
    history.pushFind("");
    expect(history.findTerms()).toEqual(["alpha"]);
  });

  it("keeps find and replace histories independent", () => {
    const history = new SearchHistory(null);
    history.pushFind("needle");
    history.pushReplace("thread");
    expect(history.findTerms()).toEqual(["needle"]);
    expect(history.replaceTerms()).toEqual(["thread"]);
  });

  it("persists across instances via the injected storage", () => {
    const storage = makeMemoryStorage();
    const first = new SearchHistory(storage);
    first.pushFind("alpha");
    first.pushReplace("beta");

    const second = new SearchHistory(storage);
    expect(second.findTerms()).toEqual(["alpha"]);
    expect(second.replaceTerms()).toEqual(["beta"]);
  });

  it("degrades to memory-only when storage throws, without throwing itself", () => {
    const storage = makeFailingStorage();
    expect(() => new SearchHistory(storage)).not.toThrow();

    const history = new SearchHistory(storage);
    expect(() => history.pushFind("alpha")).not.toThrow();
    // In-memory state still reflects the push even though persistence failed.
    expect(history.findTerms()).toEqual(["alpha"]);
  });

  it("falls back to an empty history when stored JSON is corrupt", () => {
    const storage = makeMemoryStorage();
    storage.setItem("mojidori.searchHistory.v1", "{not valid json");
    const history = new SearchHistory(storage);
    expect(history.findTerms()).toEqual([]);
    expect(history.replaceTerms()).toEqual([]);
  });

  describe("legacy key migration (plume.* -> mojidori.*)", () => {
    it("reads a value left under the legacy key and migrates it to the new key", () => {
      const storage = makeMemoryStorage();
      storage.setItem(
        "plume.searchHistory.v1",
        JSON.stringify({ find: ["legacy-term"], replace: ["legacy-repl"] }),
      );
      const history = new SearchHistory(storage);
      expect(history.findTerms()).toEqual(["legacy-term"]);
      expect(history.replaceTerms()).toEqual(["legacy-repl"]);

      // The value was copied over to the new key and the legacy key cleared.
      expect(storage.getItem("plume.searchHistory.v1")).toBeNull();
      expect(storage.getItem("mojidori.searchHistory.v1")).toBe(
        JSON.stringify({ find: ["legacy-term"], replace: ["legacy-repl"] }),
      );
    });

    it("does not let a legacy value overwrite an already-populated new key", () => {
      const storage = makeMemoryStorage();
      storage.setItem(
        "plume.searchHistory.v1",
        JSON.stringify({ find: ["legacy-term"], replace: [] }),
      );
      storage.setItem(
        "mojidori.searchHistory.v1",
        JSON.stringify({ find: ["current-term"], replace: [] }),
      );
      const history = new SearchHistory(storage);
      expect(history.findTerms()).toEqual(["current-term"]);
    });

    it("does not throw when the legacy value is corrupt JSON", () => {
      const storage = makeMemoryStorage();
      storage.setItem("plume.searchHistory.v1", "{not valid json");
      expect(() => new SearchHistory(storage)).not.toThrow();
      const history = new SearchHistory(storage);
      expect(history.findTerms()).toEqual([]);
      expect(history.replaceTerms()).toEqual([]);
    });
  });
});
