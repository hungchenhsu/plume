import { describe, expect, it, vi } from "vitest";
import { flushWithRevisionRecheck } from "./updaterflush";

describe("flushWithRevisionRecheck", () => {
  it("succeeds in one pass when the signature never changes", async () => {
    const runPass = vi.fn().mockResolvedValue(true);
    const signature = vi.fn().mockReturnValue("stable");
    const onRetry = vi.fn();

    const result = await flushWithRevisionRecheck({
      runPass,
      signature,
      maxRetries: 2,
      onRetry,
    });

    expect(result).toBe(true);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("returns false immediately on a genuine pass failure, never retrying", async () => {
    const runPass = vi.fn().mockResolvedValue(false);
    const signature = vi.fn().mockReturnValue("stable");
    const onRetry = vi.fn();

    const result = await flushWithRevisionRecheck({
      runPass,
      signature,
      maxRetries: 2,
      onRetry,
    });

    expect(result).toBe(false);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries once when the signature changes during the first pass, then succeeds", async () => {
    const runPass = vi.fn().mockResolvedValue(true);
    // "before" read for attempt 1, "after" read for attempt 1 (changed),
    // "before" read for attempt 2, "after" read for attempt 2 (stable).
    const signature = vi
      .fn()
      .mockReturnValueOnce("v1")
      .mockReturnValueOnce("v2")
      .mockReturnValueOnce("v3")
      .mockReturnValueOnce("v3");
    const onRetry = vi.fn();

    const result = await flushWithRevisionRecheck({
      runPass,
      signature,
      maxRetries: 2,
      onRetry,
    });

    expect(result).toBe(true);
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 3);
  });

  it("gives up and returns false once every retry is spent and the signature keeps changing", async () => {
    const runPass = vi.fn().mockResolvedValue(true);
    let counter = 0;
    const signature = vi.fn(() => `v${counter++}`); // every read differs
    const onRetry = vi.fn();

    const result = await flushWithRevisionRecheck({
      runPass,
      signature,
      maxRetries: 2,
      onRetry,
    });

    expect(result).toBe(false);
    // maxRetries: 2 -> 3 total attempts (1 initial + 2 retries).
    expect(runPass).toHaveBeenCalledTimes(3);
    // onRetry fires after attempts 1 and 2, not after the final exhausted
    // attempt 3 — nothing is actually retried after it.
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 3);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 3);
  });

  it("with maxRetries: 0, never retries even on a changed signature", async () => {
    const runPass = vi.fn().mockResolvedValue(true);
    const signature = vi.fn().mockReturnValueOnce("v1").mockReturnValueOnce("v2");
    const onRetry = vi.fn();

    const result = await flushWithRevisionRecheck({
      runPass,
      signature,
      maxRetries: 0,
      onRetry,
    });

    expect(result).toBe(false);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("onRetry is optional", async () => {
    const runPass = vi.fn().mockResolvedValue(true);
    // attempt 1: before="v1", after="v2" (changed, retry).
    // attempt 2: before="v2", after="v2" (stable, done).
    const signature = vi
      .fn()
      .mockReturnValueOnce("v1")
      .mockReturnValueOnce("v2")
      .mockReturnValueOnce("v2")
      .mockReturnValueOnce("v2");

    const result = await flushWithRevisionRecheck({ runPass, signature, maxRetries: 2 });

    expect(result).toBe(true);
    expect(runPass).toHaveBeenCalledTimes(2);
  });
});
