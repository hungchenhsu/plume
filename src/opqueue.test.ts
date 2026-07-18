import { describe, expect, it } from "vitest";
import { createOpQueue } from "./opqueue";

/** A promise whose resolve/reject are triggered from the outside. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createOpQueue", () => {
  it("passes each operation's value through", async () => {
    const queue = createOpQueue();
    await expect(queue.enqueue(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it("does not start an operation until the previous one settled", async () => {
    const queue = createOpQueue();
    const first = deferred<string[]>();
    const started: string[] = [];

    const p1 = queue.enqueue(() => {
      started.push("add");
      return first.promise;
    });
    const p2 = queue.enqueue(() => {
      started.push("clear");
      return Promise.resolve([]);
    });

    // Let any (incorrectly) eager start happen.
    await Promise.resolve();
    expect(started).toEqual(["add"]);

    first.resolve(["a.txt"]);
    await expect(p1).resolves.toEqual(["a.txt"]);
    await expect(p2).resolves.toEqual([]);
    expect(started).toEqual(["add", "clear"]);
  });

  // Regression for issue #252: an in-flight add resolving after a later
  // Clear must not hand its pre-clear list to the cache last. With the
  // queue, the add settles (and its caller applies its result) strictly
  // before the clear even starts.
  it("applies results in enqueue order even when the first is slow", async () => {
    const queue = createOpQueue();
    const slowAdd = deferred<string[]>();
    const applied: string[][] = [];

    const add = queue
      .enqueue(() => slowAdd.promise)
      .then((list) => applied.push(list));
    const clear = queue
      .enqueue(() => Promise.resolve([]))
      .then((list) => applied.push(list));

    slowAdd.resolve(["stale.txt"]);
    await Promise.all([add, clear]);
    expect(applied).toEqual([["stale.txt"], []]);
  });

  it("rejections pass through to the operation's caller", async () => {
    const queue = createOpQueue();
    await expect(
      queue.enqueue(() => Promise.reject(new Error("disk full"))),
    ).rejects.toThrow("disk full");
  });

  it("a failed operation does not block later ones", async () => {
    const queue = createOpQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error("boom")));
    const after = queue.enqueue(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });
});
