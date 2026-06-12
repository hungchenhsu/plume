import { describe, expect, it } from "vitest";
import { pushBack, pushFront, type WindowChunk } from "./chunkwindow";

function chunk(chars: number, bytes: number): WindowChunk {
  return { chars, bytes };
}

describe("pushBack", () => {
  it("grows the window without trimming under the budget", () => {
    const window = [chunk(10, 12)];
    expect(pushBack(window, chunk(20, 22), 3)).toBeNull();
    expect(window.length).toBe(2);
  });

  it("trims the first chunk when over budget", () => {
    const window = [chunk(10, 12), chunk(20, 22)];
    const trim = pushBack(window, chunk(30, 33), 2);
    expect(trim).toEqual({ trimChars: 10, trimBytes: 12 });
    expect(window.map((c) => c.chars)).toEqual([20, 30]);
  });
});

describe("pushFront", () => {
  it("grows the window without trimming under the budget", () => {
    const window = [chunk(10, 12)];
    expect(pushFront(window, chunk(5, 6), 3)).toBeNull();
    expect(window.map((c) => c.chars)).toEqual([5, 10]);
  });

  it("trims the last chunk when over budget", () => {
    const window = [chunk(10, 12), chunk(20, 22)];
    const trim = pushFront(window, chunk(5, 6), 2);
    expect(trim).toEqual({ trimChars: 20, trimBytes: 22 });
    expect(window.map((c) => c.chars)).toEqual([5, 10]);
  });
});
