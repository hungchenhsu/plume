import { describe, expect, it, vi } from "vitest";
import type { EditorBuffer } from "./editor";
import { DRAG_THRESHOLD_PX, isEffectivelyReadOnly, TabStore, type Doc } from "./tabs";

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
    revision: 0,
    truncated: false,
    userReadOnly: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    saveReloadInFlight: null,
    pendingReload: false,
    pendingSaveAs: null,
    backupName: null,
    fingerprint: null,
    buffer: {} as EditorBuffer,
  };
}

function makeStore() {
  const container = document.createElement("div");
  const events = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onReorder: vi.fn(),
  };
  return { store: new TabStore(container, events), container, events };
}

/** Dispatch a full click gesture (pointerdown + pointerup, no movement) at
 *  `clientX` on `el`, matching how selection actually resolves (see
 *  tabs.ts's onTabPointerUp: a click-with-no-drag selects on release, not
 *  on press). `button` defaults to the primary button. */
function pointerClick(el: Element, clientX = 0, button = 0): void {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      button,
      pointerId: 1,
      clientX,
      bubbles: true,
    }),
  );
  el.dispatchEvent(
    new PointerEvent("pointerup", { pointerId: 1, clientX, bubbles: true }),
  );
}

/** Stub a tab element's layout as a `width`-wide slot starting at `left`,
 *  since jsdom has no real layout engine and getBoundingClientRect()
 *  otherwise always reports all-zero rects — needed to exercise the
 *  drop-slot hit-testing in commitReorder deterministically. */
function stubRect(el: HTMLElement, left: number, width = 100): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left,
    width,
    right: left + width,
    top: 0,
    bottom: 0,
    height: 0,
    x: left,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect);
}

// ROADMAP.md v0.4 Track C per-tab read-only mode: truncated (large-file
// preview) read-only can never be lifted; userReadOnly is the user's own
// per-tab lock, layered independently on top of it. Exhaustive over the
// 2x2 combination table since this is the single formula every read-only
// enforcement/UI call site (editor.ts's setReadOnly, the View menu's
// checked/enabled state, the status bar badge, saveFlow/runLineOperation's
// guard) is built on.
describe("isEffectivelyReadOnly", () => {
  it("is false when neither truncated nor userReadOnly is set", () => {
    expect(isEffectivelyReadOnly({ truncated: false, userReadOnly: false })).toBe(false);
  });

  it("is true when only truncated is set", () => {
    expect(isEffectivelyReadOnly({ truncated: true, userReadOnly: false })).toBe(true);
  });

  it("is true when only userReadOnly is set", () => {
    expect(isEffectivelyReadOnly({ truncated: false, userReadOnly: true })).toBe(true);
  });

  it("is true when both truncated and userReadOnly are set", () => {
    expect(isEffectivelyReadOnly({ truncated: true, userReadOnly: true })).toBe(true);
  });
});

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

    pointerClick(tabs[0]);
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

describe("TabStore.moveTab (pure reorder logic)", () => {
  it("moves a doc from the front to the back", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
  });

  it("moves a doc from the back to the front", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.moveTab(2, 0);
    expect(store.docs.map((d) => d.id)).toEqual([3, 1, 2]);
  });

  it("shifts only the tabs between the source and destination", () => {
    const { store } = makeStore();
    for (const id of [1, 2, 3, 4, 5]) store.add(makeDoc(id));
    store.moveTab(4, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 5, 2, 3, 4]);
  });

  it("is a no-op when fromIndex equals toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(1, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("is a no-op for a negative fromIndex or toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(-1, 1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    store.moveTab(0, -1);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("is a no-op for an out-of-range fromIndex or toIndex", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.moveTab(0, 5);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    store.moveTab(5, 0);
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("leaves an empty or single-tab store untouched", () => {
    const { store } = makeStore();
    store.moveTab(0, 0);
    expect(store.docs).toEqual([]);
    store.add(makeDoc(1));
    store.moveTab(0, 0);
    expect(store.docs.map((d) => d.id)).toEqual([1]);
  });

  it("keeps activeId pointing at the same doc when a different tab moves around it", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2);
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(2);
  });

  it("keeps the moved tab active when the active tab itself is the one moved", () => {
    const { store } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(1);
    store.moveTab(0, 2);
    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(1);
  });
});

describe("TabStore pointer drag-to-reorder", () => {
  it("selects on a plain click (no movement) and does not reorder", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();

    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    pointerClick(tabs[0], 50);

    expect(events.onSelect).toHaveBeenCalledWith(1);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
  });

  it("does not enter dragging mode below the threshold, and still selects on release", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX - 1,
        bubbles: true,
      }),
    );
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX - 1,
        bubbles: true,
      }),
    );
    expect(events.onSelect).toHaveBeenCalledWith(1);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("enters dragging mode once past the threshold and applies visual feedback", () => {
    const { store, container } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 50 + DRAG_THRESHOLD_PX,
        bubbles: true,
      }),
    );

    expect(tabs[0].classList.contains("tab-dragging")).toBe(true);
    expect(tabs[0].style.transform).toBe(`translateX(${DRAG_THRESHOLD_PX}px)`);
  });

  it("never enters dragging mode for a middle or right-click, but still selects on release", () => {
    for (const button of [1, 2]) {
      const { store, container, events } = makeStore();
      store.add(makeDoc(1));
      store.add(makeDoc(2));
      store.render();
      const tabs = container.querySelectorAll<HTMLElement>(".tab");
      stubRect(tabs[0], 0);
      stubRect(tabs[1], 100);

      tabs[0].dispatchEvent(
        new PointerEvent("pointerdown", {
          button,
          pointerId: 1,
          clientX: 50,
          bubbles: true,
        }),
      );
      tabs[0].dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          clientX: 300, // far past the threshold
          bubbles: true,
        }),
      );
      expect(tabs[0].classList.contains("tab-dragging")).toBe(false);

      tabs[0].dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 1, clientX: 300, bubbles: true }),
      );
      expect(events.onSelect).toHaveBeenCalledWith(1);
      expect(events.onReorder).not.toHaveBeenCalled();
      expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    }
  });

  it("never arms a drag or selects from a pointerdown on the close button", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.render();
    const close = container.querySelector(".tab-close")!;

    close.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 0,
        bubbles: true,
      }),
    );
    close.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 300, bubbles: true }),
    );
    close.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 300, bubbles: true }),
    );

    expect(events.onSelect).not.toHaveBeenCalled();
    expect(events.onReorder).not.toHaveBeenCalled();
  });

  it("resets visual state without selecting or reordering on pointercancel", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0);
    stubRect(tabs[1], 100);

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 300, bubbles: true }),
    );
    expect(tabs[0].classList.contains("tab-dragging")).toBe(true);

    tabs[0].dispatchEvent(
      new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
    );

    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    expect(tabs[0].style.transform).toBe("");
    expect(events.onSelect).not.toHaveBeenCalled();
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
  });

  it("reorders end-to-end when dropped past a neighbor's midpoint, tracking activeId by id", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.add(makeDoc(3));
    store.setActive(2); // active tab is not the one being dragged
    store.render();

    let tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0); // doc 1: [0, 100), center 50
    stubRect(tabs[1], 100); // doc 2: [100, 200), center 150
    stubRect(tabs[2], 200); // doc 3: [200, 300), center 250

    // Drag doc 1 from its own center (50) past both neighbors' centers.
    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 260, bubbles: true }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 260, bubbles: true }),
    );

    expect(store.docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(store.activeId).toBe(2); // unchanged: tracked by id, not index
    expect(events.onReorder).toHaveBeenCalledTimes(1);
    expect(events.onSelect).not.toHaveBeenCalled();

    // render() rebuilt the DOM; the old element is detached and no longer
    // carries the drag's leftover class/transform.
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    tabs = container.querySelectorAll<HTMLElement>(".tab");
    expect(tabs.length).toBe(3);
  });

  it("does not reorder or fire onReorder when dropped back on its own slot", () => {
    const { store, container, events } = makeStore();
    store.add(makeDoc(1));
    store.add(makeDoc(2));
    store.render();
    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    stubRect(tabs[0], 0); // doc 1: [0, 100), center 50
    stubRect(tabs[1], 100); // doc 2: [100, 200), center 150

    tabs[0].dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        clientX: 50,
        bubbles: true,
      }),
    );
    // Move past the threshold, then back to (near) the start — still
    // short of doc 2's center (150), so the drop slot resolves to the
    // same index it started at.
    tabs[0].dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 70, bubbles: true }),
    );
    tabs[0].dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 52, bubbles: true }),
    );

    expect(store.docs.map((d) => d.id)).toEqual([1, 2]);
    expect(events.onReorder).not.toHaveBeenCalled();
    expect(events.onSelect).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains("tab-dragging")).toBe(false);
    expect(tabs[0].style.transform).toBe("");
  });
});
