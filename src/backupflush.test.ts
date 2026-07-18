import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupFlushScheduler } from "./backupflush";

interface FakeDoc {
  name: string;
  dirty: boolean;
  truncated: boolean;
}

function doc(name: string, over: Partial<FakeDoc> = {}): FakeDoc {
  return { name, dirty: true, truncated: false, ...over };
}

const DEBOUNCE = 2000;

function setup(initialActive: FakeDoc | null): {
  flushes: Array<{ doc: FakeDoc; content: string }>;
  setActive: (d: FakeDoc | null, content?: string) => void;
  scheduler: ReturnType<typeof createBackupFlushScheduler<FakeDoc>>;
} {
  let active = initialActive;
  let activeContent = "";
  const flushes: Array<{ doc: FakeDoc; content: string }> = [];
  const scheduler = createBackupFlushScheduler<FakeDoc>({
    debounceMs: DEBOUNCE,
    active: () => active,
    activeContent: () => activeContent,
    flush: (d, content) => {
      flushes.push({ doc: d, content });
      return Promise.resolve();
    },
  });
  return {
    flushes,
    setActive: (d, content = "") => {
      active = d;
      activeContent = content;
    },
    scheduler,
  };
}

describe("createBackupFlushScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes the active document's content when the debounce expires", () => {
    const a = doc("a");
    const { flushes, setActive, scheduler } = setup(a);
    setActive(a, "hello");
    scheduler.schedule();
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toEqual([{ doc: a, content: "hello" }]);
  });

  it("restarts the debounce window on every schedule call", () => {
    const a = doc("a");
    const { flushes, setActive, scheduler } = setup(a);
    setActive(a, "v1");
    scheduler.schedule();
    vi.advanceTimersByTime(DEBOUNCE - 1);
    setActive(a, "v2");
    scheduler.schedule();
    vi.advanceTimersByTime(DEBOUNCE - 1);
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushes).toEqual([{ doc: a, content: "v2" }]);
  });

  it("does not flush a clean or truncated active document", () => {
    for (const d of [doc("clean", { dirty: false }), doc("preview", { truncated: true })]) {
      const { flushes, scheduler } = setup(d);
      scheduler.schedule();
      vi.advanceTimersByTime(DEBOUNCE);
      expect(flushes).toEqual([]);
    }
  });

  it("does not flush when the active tab was closed to null", () => {
    const { flushes, setActive, scheduler } = setup(doc("a"));
    scheduler.schedule();
    setActive(null);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toEqual([]);
  });

  it("flushPending flushes the given document immediately and cancels the timer", () => {
    const a = doc("a");
    const { flushes, setActive, scheduler } = setup(a);
    setActive(a, "live text");
    scheduler.schedule();
    scheduler.flushPending(a, "snapshot text");
    expect(flushes).toEqual([{ doc: a, content: "snapshot text" }]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toHaveLength(1);
  });

  it("flushPending is a no-op when nothing is pending", () => {
    const a = doc("a");
    const { flushes, scheduler } = setup(a);
    scheduler.flushPending(a, "text");
    expect(flushes).toEqual([]);
  });

  it("flushPending cancels the timer without flushing for a clean document", () => {
    const clean = doc("clean", { dirty: false });
    const { flushes, scheduler } = setup(clean);
    scheduler.schedule();
    scheduler.flushPending(clean, "text");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toEqual([]);
  });

  it("cancel drops the pending flush entirely", () => {
    const a = doc("a");
    const { flushes, scheduler } = setup(a);
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toEqual([]);
  });

  // Regression for issue #253: editing doc A and switching tabs inside the
  // debounce window must still back up A. Before the fix, newTab/cycleTab
  // left the timer running; it fired seeing the new active document and
  // A's edits never reached A's backup.
  it("backs up the previous document when a tab switch lands inside the debounce window", () => {
    const a = doc("a");
    const b = doc("b", { dirty: false });
    const { flushes, setActive, scheduler } = setup(a);
    setActive(a, "unsaved edits to A");
    scheduler.schedule();
    vi.advanceTimersByTime(DEBOUNCE / 2);
    // The switch path snapshots A's buffer, then hands it to flushPending
    // before the active tab flips to B.
    scheduler.flushPending(a, "unsaved edits to A");
    setActive(b, "content of B");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(flushes).toEqual([{ doc: a, content: "unsaved edits to A" }]);
  });
});
