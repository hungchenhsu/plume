import { describe, expect, it, vi } from "vitest";
import type { EditorBuffer } from "./editor";
import { TabStore, type Doc } from "./tabs";

function makeDoc(id: number, path: string | null = null): Doc {
  return {
    id,
    path,
    title: path ? (path.split("/").pop() ?? path) : `Untitled-${id}`,
    encoding: "UTF-8",
    withBom: false,
    lineEnding: "LF",
    malformed: false,
    dirty: false,
    truncated: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    loadedChunks: 1,
    buffer: {} as EditorBuffer,
  };
}

function makeStore() {
  const container = document.createElement("div");
  const events = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
  return { store: new TabStore(container, events), container, events };
}

describe("TabStore", () => {
  it("activates a doc when it is added", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    expect(store.activeId).toBe(2);
    expect(store.active?.id).toBe(2);
  });

  it("activates the right neighbor when the active tab closes", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2);
    store.close(2);
    expect(store.docs.map((d) => d.id)).toEqual([1, 3]);
    expect(store.activeId).toBe(3);
  });

  it("falls back to the left neighbor when the last tab closes", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.close(2);
    expect(store.activeId).toBe(1);
  });

  it("keeps the active tab when closing another tab", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.close(1);
    expect(store.activeId).toBe(2);
  });

  it("cycles through tabs with wrap-around", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.cycle(1);
    expect(store.activeId).toBe(1);
    store.cycle(-1);
    expect(store.activeId).toBe(3);
  });

  it("finds docs by path", () => {
    const { store } = makeStore();
    store.add(makeDoc(1, "/tmp/a.txt"));
    store.add(makeDoc(2, "/tmp/b.txt"));
    expect(store.findByPath("/tmp/a.txt")?.id).toBe(1);
    expect(store.findByPath("/tmp/missing.txt")).toBeNull();
  });

  it("renders tabs with dirty indicators and wires events", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1, "/tmp/a.txt"));
    store.add(makeDoc(2));
    store.docs[0].dirty = true;
    store.render();

    const tabs = container.querySelectorAll(".tab");
    expect(tabs.length).toBe(2);
    expect(tabs[1].classList.contains("active")).toBe(true);
    expect(tabs[0].querySelector(".tab-close")?.textContent).toBe("●");
    expect(tabs[1].querySelector(".tab-close")?.textContent).toBe("×");

    tabs[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(events.onSelect).toHaveBeenCalledWith(1);

    tabs[0]
      .querySelector(".tab-close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events.onClose).toHaveBeenCalledWith(1);

    container
      .querySelector(".tab-new")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events.onNew).toHaveBeenCalled();
  });
});
