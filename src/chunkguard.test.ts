import { describe, expect, it } from "vitest";
import { canAutoAppend } from "./chunkpolicy";
import { preemptChunkLoad, shouldApplyChunkResponse } from "./chunkguard";

describe("shouldApplyChunkResponse — full branch table", () => {
  it("applies when the generation matches and the tab is still active", () => {
    expect(
      shouldApplyChunkResponse({
        requestGeneration: 3,
        currentGeneration: 3,
        isActiveTab: true,
      }),
    ).toBe(true);
  });

  it("discards when a newer request (or a reload/reopen) has bumped the generation, even if still the active tab", () => {
    expect(
      shouldApplyChunkResponse({
        requestGeneration: 3,
        currentGeneration: 4,
        isActiveTab: true,
      }),
    ).toBe(false);
  });

  it("discards when the tab is no longer active, even if the generation still matches", () => {
    expect(
      shouldApplyChunkResponse({
        requestGeneration: 3,
        currentGeneration: 3,
        isActiveTab: false,
      }),
    ).toBe(false);
  });

  it("discards when both conditions fail", () => {
    expect(
      shouldApplyChunkResponse({
        requestGeneration: 1,
        currentGeneration: 9,
        isActiveTab: false,
      }),
    ).toBe(false);
  });
});

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold a chunk IPC mock's response open across another
 *  synchronous action (e.g. a second request being issued) before
 *  deciding when it "arrives". Same shape as batchconvert.test.ts /
 *  savecompletion.test.ts's helper. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal stand-in for the slice of tabs.ts's Doc + TabStore state that a
 *  chunk-mutating call (pageChunk/autoAppendChunk/prependChunk/
 *  gotoLargeFileLine in main.ts) reads and writes, so this test can drive
 *  the exact generation-bump-then-await-then-guard shape those call sites
 *  use without pulling in the DOM/editor/IPC main.ts is wired to (main.ts
 *  itself has no *.test.ts — see savecompletion.ts's module comment for
 *  why this pure-extraction-plus-simulation pattern is used instead). */
function makeDocState() {
  return {
    chunkGeneration: 0,
    activeId: 1 as number | null,
    docId: 1,
    applied: [] as string[],
  };
}

/** Mirrors one main.ts chunk-mutating call site: bump the generation,
 *  capture it, await the (mocked) IPC call, then apply only if nothing
 *  has superseded it since. */
async function issueChunkRequest(
  doc: ReturnType<typeof makeDocState>,
  fetchContent: () => Promise<string>,
): Promise<void> {
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  const content = await fetchContent();
  if (
    !shouldApplyChunkResponse({
      requestGeneration: myGeneration,
      currentGeneration: doc.chunkGeneration,
      isActiveTab: doc.activeId === doc.docId,
    })
  ) {
    return;
  }
  doc.applied.push(content);
}

describe("shouldApplyChunkResponse — issue #120 race scenarios", () => {
  it("a slow first request superseded by a second is discarded even though it resolves last (rapid Next/Next)", async () => {
    const doc = makeDocState();
    const first = deferred<string>();
    const second = deferred<string>();

    const p1 = issueChunkRequest(doc, () => first.promise); // e.g. first Next click
    const p2 = issueChunkRequest(doc, () => second.promise); // e.g. second Next click before the first returned

    // The second (newer) request's response arrives first...
    second.resolve("page-2");
    await p2;
    // ...then the stale first response arrives late.
    first.resolve("page-1-stale");
    await p1;

    // Only the second (later-issued) request's content ever lands.
    expect(doc.applied).toEqual(["page-2"]);
  });

  it("a normal, non-overlapping sequence of requests all apply in order", async () => {
    const doc = makeDocState();
    await issueChunkRequest(doc, () => Promise.resolve("page-1"));
    await issueChunkRequest(doc, () => Promise.resolve("page-2"));
    expect(doc.applied).toEqual(["page-1", "page-2"]);
  });

  it("a response for a doc the user has switched away from is discarded", async () => {
    const doc = makeDocState();
    const inFlight = deferred<string>();
    const p = issueChunkRequest(doc, () => inFlight.promise);
    doc.activeId = 999; // user switched to a different tab
    inFlight.resolve("page-1");
    await p;
    expect(doc.applied).toEqual([]);
  });

  it("a reload/reopen bumping the generation while a request is in flight discards that request's response", async () => {
    const doc = makeDocState();
    const inFlight = deferred<string>();
    const p = issueChunkRequest(doc, () => inFlight.promise);
    // Mirrors reloadFromDisk/reopenWithEncoding: invalidate whatever's in
    // flight the instant the doc's chunk-window state gets reset.
    doc.chunkGeneration += 1;
    inFlight.resolve("stale-pre-reload-content");
    await p;
    expect(doc.applied).toEqual([]);
  });
});

/** Minimal stand-in for the slice of tabs.ts's Doc that pageChunk (Next/
 *  Prev)/gotoLargeFileLine/autoAppendChunk (main.ts) read and write for
 *  the in-flight-preemption behavior added for issue #134 — the
 *  generation/active-tab slice above (makeDocState) plus the fields
 *  needed to (a) decide whether a request preempts (user-initiated) or
 *  yields (auto) when something is already in flight, and (b) exercise
 *  pageChunk's Prev "pop only once confirmed current" offset-history
 *  invariant (#120) under preemption. */
function makePagingDocState() {
  return {
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    activeId: 1 as number | null,
    docId: 1,
    nextChunkOffset: 100 as number | null,
    prevChunkOffsets: [10, 20] as number[],
    applied: [] as string[],
  };
}

type PagingDocState = ReturnType<typeof makePagingDocState>;

/** Mirrors pageChunk's Next direction / gotoLargeFileLine: user-initiated
 *  requests. Issue #134: these must preempt (bump the generation, clear
 *  the flag) a request already in flight rather than silently no-op on
 *  it — see the entry guard these two functions share in main.ts. */
async function issueUserChunkRequest(
  doc: PagingDocState,
  fetchContent: () => Promise<string>,
): Promise<void> {
  if (doc.chunkLoadInFlight) preemptChunkLoad(doc);
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const content = await fetchContent();
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: doc.activeId === doc.docId,
      })
    ) {
      return;
    }
    doc.applied.push(content);
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/** Mirrors pageChunk's Prev direction specifically: peeks
 *  `prevChunkOffsets` before issuing the request and only pops once the
 *  response is confirmed current (#120) — must still hold under
 *  preemption (#134). */
async function issueUserPrevRequest(
  doc: PagingDocState,
  fetchContent: () => Promise<string>,
): Promise<void> {
  if (doc.chunkLoadInFlight) preemptChunkLoad(doc);
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const content = await fetchContent();
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: doc.activeId === doc.docId,
      })
    ) {
      return;
    }
    doc.prevChunkOffsets.pop();
    doc.applied.push(content);
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/** Mirrors autoAppendChunk: auto-triggered — must keep yielding (no-op)
 *  when a request is already in flight rather than preempting it (issue
 *  #134 only changes user-initiated call sites). Uses the real
 *  chunkpolicy.ts guard so this stays honest if that policy ever changes. */
async function issueAutoChunkRequest(
  doc: PagingDocState,
  fetchContent: () => Promise<string>,
): Promise<void> {
  if (!canAutoAppend({ nextOffset: doc.nextChunkOffset, inFlight: doc.chunkLoadInFlight })) {
    return;
  }
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const content = await fetchContent();
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: doc.activeId === doc.docId,
      })
    ) {
      return;
    }
    doc.applied.push(content);
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

describe("issue #134 — user-initiated jumps preempt an in-flight auto append/prepend", () => {
  it("goto-during-auto: a user goto must not silently no-op while an auto append is in flight", async () => {
    const doc = makePagingDocState();
    const auto = deferred<string>();
    const gotoResp = deferred<string>();

    const autoP = issueAutoChunkRequest(doc, () => auto.promise); // scroll-triggered auto append starts...
    expect(doc.chunkLoadInFlight).toBe(true); // ...and is still in flight when the user acts.

    const gotoP = issueUserChunkRequest(doc, () => gotoResp.promise); // user: Go to Line

    gotoResp.resolve("goto-target-content");
    await gotoP;
    auto.resolve("stale-auto-content");
    await autoP;

    expect(doc.applied).toEqual(["goto-target-content"]);
  });

  it("Next-during-auto: a user Next must not silently no-op while an auto append is in flight", async () => {
    const doc = makePagingDocState();
    const auto = deferred<string>();
    const next = deferred<string>();

    const autoP = issueAutoChunkRequest(doc, () => auto.promise);
    expect(doc.chunkLoadInFlight).toBe(true);

    const nextP = issueUserChunkRequest(doc, () => next.promise); // user: Next click

    next.resolve("next-chunk-content");
    await nextP;
    auto.resolve("stale-auto-content");
    await autoP;

    expect(doc.applied).toEqual(["next-chunk-content"]);
  });

  it("Next-Next (double click): the second click preempts the first instead of no-opping", async () => {
    const doc = makePagingDocState();
    const first = deferred<string>();
    const second = deferred<string>();

    const p1 = issueUserChunkRequest(doc, () => first.promise);
    const p2 = issueUserChunkRequest(doc, () => second.promise);

    second.resolve("page-2");
    await p2;
    first.resolve("page-1-stale");
    await p1;

    expect(doc.applied).toEqual(["page-2"]);
  });

  it("Prev-Prev (double click): the winning (second) request still pops the offset-history exactly once — #120's pop-timing invariant survives preemption", async () => {
    const doc = makePagingDocState();
    const first = deferred<string>();
    const second = deferred<string>();

    const p1 = issueUserPrevRequest(doc, () => first.promise);
    const p2 = issueUserPrevRequest(doc, () => second.promise);

    second.resolve("page-prev-2");
    await p2;
    first.resolve("page-prev-1-stale");
    await p1;

    expect(doc.applied).toEqual(["page-prev-2"]);
    expect(doc.prevChunkOffsets).toEqual([10]);
  });

  it("auto append still yields (never preempts) when a user request is already in flight", async () => {
    const doc = makePagingDocState();
    const user = deferred<string>();

    const userP = issueUserChunkRequest(doc, () => user.promise);
    await issueAutoChunkRequest(doc, () => {
      throw new Error("auto must not even attempt a request while a user request is in flight");
    });

    user.resolve("user-content");
    await userP;

    expect(doc.applied).toEqual(["user-content"]);
    expect(doc.chunkLoadInFlight).toBe(false);
  });
});
