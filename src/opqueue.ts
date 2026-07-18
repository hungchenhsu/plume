// Minimal async operation serializer (issue #252, first applied to the
// recent-files IPC pair in main.ts). Some backend commands are
// read-modify-write over one shared resource (recent.json): firing them
// concurrently lets calls interleave on the backend — an add that read the
// list before a clear wrote it can write the pre-clear list back — and
// even without backend interleaving, responses resolving out of order let
// a stale result overwrite the frontend cache of a later operation.
// Serializing through one queue removes both orderings by construction:
// an operation starts only after the previous one settled, and therefore
// also resolves after it.
//
// A stateful closure factory rather than a pure capture/validate pair
// (asyncguard.ts's shape) because ordering *is* state: something has to
// remember the tail of the chain. Same reasoning as backupflush.ts owning
// its timer. Kept generic — nothing recent-specific — so the next
// read-modify-write command pair can reuse it.

export interface OpQueue {
  /** Run `op` after every previously enqueued operation has settled.
   *  Returns `op`'s own promise (value and rejection pass through
   *  unchanged); one operation's failure never blocks later ones. */
  enqueue<T>(op: () => Promise<T>): Promise<T>;
}

export function createOpQueue(): OpQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(op: () => Promise<T>): Promise<T> {
      // `op` runs whether the previous operation fulfilled or rejected —
      // rejection handling belongs to each operation's own caller.
      const next = tail.then(op, op);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
