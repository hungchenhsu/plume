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
    storage.setItem("plume.searchHistory.v1", "{not valid json");
    const history = new SearchHistory(storage);
    expect(history.findTerms()).toEqual([]);
    expect(history.replaceTerms()).toEqual([]);
  });
});
