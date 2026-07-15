import { describe, expect, it } from "vitest";
import {
  ClosedTabsStack,
  MAX_CLOSED_TABS,
  hasClosedTabs,
  popClosedTab,
  recordClosedTab,
} from "./closedtabs";

describe("ClosedTabsStack — push/pop", () => {
  it("pops the most recently pushed entry first (LIFO)", () => {
    const stack = new ClosedTabsStack();
    stack.push("/a.txt", 0);
    stack.push("/b.txt", 0);
    stack.push("/c.txt", 0);
    expect(stack.pop()?.path).toBe("/c.txt");
    expect(stack.pop()?.path).toBe("/b.txt");
    expect(stack.pop()?.path).toBe("/a.txt");
  });

  it("returns the cursor recorded at close time", () => {
    const stack = new ClosedTabsStack();
    stack.push("/a.txt", 42);
    expect(stack.pop()).toEqual({ path: "/a.txt", cursor: 42 });
  });

  it("pop on an empty stack returns null", () => {
    expect(new ClosedTabsStack().pop()).toBeNull();
  });

  it("pop consumes the entry — a failed reopen does not put it back", () => {
    // The caller never re-pushes on an open error (see pop's doc comment):
    // after one pop the next pop must already be the previous entry.
    const stack = new ClosedTabsStack();
    stack.push("/older.txt", 1);
    stack.push("/deleted-since-close.txt", 2);
    expect(stack.pop()?.path).toBe("/deleted-since-close.txt");
    expect(stack.pop()?.path).toBe("/older.txt");
    expect(stack.pop()).toBeNull();
  });

  it("isEmpty tracks the push/pop lifecycle", () => {
    const stack = new ClosedTabsStack();
    expect(stack.isEmpty()).toBe(true);
    stack.push("/a.txt", 0);
    expect(stack.isEmpty()).toBe(false);
    stack.pop();
    expect(stack.isEmpty()).toBe(true);
  });
});

describe("ClosedTabsStack — untitled exclusion", () => {
  it("ignores a push with path null", () => {
    const stack = new ClosedTabsStack();
    stack.push(null, 42);
    expect(stack.isEmpty()).toBe(true);
    expect(stack.pop()).toBeNull();
  });

  it("keeps real entries intact when an untitled push is interleaved", () => {
    const stack = new ClosedTabsStack();
    stack.push("/a.txt", 5);
    stack.push(null, 99);
    expect(stack.pop()).toEqual({ path: "/a.txt", cursor: 5 });
  });
});

describe("ClosedTabsStack — duplicate paths", () => {
  it("re-closing a stacked path replaces the older entry (most-recent-wins)", () => {
    const stack = new ClosedTabsStack();
    stack.push("/a.txt", 5);
    stack.push("/b.txt", 9);
    stack.push("/a.txt", 30);
    expect(stack.pop()).toEqual({ path: "/a.txt", cursor: 30 });
    expect(stack.pop()).toEqual({ path: "/b.txt", cursor: 9 });
    expect(stack.pop()).toBeNull();
  });
});

describe("ClosedTabsStack — cap", () => {
  it("drops the oldest entry beyond MAX_CLOSED_TABS", () => {
    const stack = new ClosedTabsStack();
    for (let i = 0; i <= MAX_CLOSED_TABS; i++) {
      stack.push(`/file-${i}.txt`, i);
    }
    // Newest first, exactly MAX_CLOSED_TABS entries; /file-0.txt is gone.
    for (let i = MAX_CLOSED_TABS; i >= 1; i--) {
      expect(stack.pop()).toEqual({ path: `/file-${i}.txt`, cursor: i });
    }
    expect(stack.pop()).toBeNull();
  });

  it("a duplicate push does not evict anything (net size unchanged)", () => {
    const stack = new ClosedTabsStack();
    for (let i = 1; i <= MAX_CLOSED_TABS; i++) {
      stack.push(`/file-${i}.txt`, i);
    }
    // Re-close the newest path: still MAX entries, /file-1.txt survives.
    stack.push(`/file-${MAX_CLOSED_TABS}.txt`, 0);
    for (let i = MAX_CLOSED_TABS; i >= 1; i--) {
      expect(stack.pop()?.path).toBe(`/file-${i}.txt`);
    }
    expect(stack.pop()).toBeNull();
  });
});

describe("module singleton wrappers", () => {
  it("recordClosedTab/popClosedTab/hasClosedTabs share one stack", () => {
    expect(hasClosedTabs()).toBe(false);
    recordClosedTab(null, 7); // untitled: excluded through the wrapper too
    expect(hasClosedTabs()).toBe(false);
    recordClosedTab("/x.txt", 3);
    expect(hasClosedTabs()).toBe(true);
    expect(popClosedTab()).toEqual({ path: "/x.txt", cursor: 3 });
    expect(hasClosedTabs()).toBe(false);
    expect(popClosedTab()).toBeNull();
  });
});
