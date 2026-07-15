import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenu, showMenu } from "./popup";

function anchor(): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

describe("showMenu", () => {
  afterEach(() => {
    closeMenu();
    document.body.innerHTML = "";
  });

  it("renders a header-less item list exactly as before: one clickable .popup-item button per entry", () => {
    const action = vi.fn();
    showMenu(anchor(), [
      { label: "Alpha", action },
      { label: "Beta", checked: true },
      { label: "Gamma", disabled: true },
    ]);
    const menu = document.querySelector(".popup-menu");
    expect(menu).not.toBeNull();
    const buttons = menu!.querySelectorAll("button.popup-item");
    expect(buttons).toHaveLength(3);
    expect(menu!.querySelectorAll(".popup-section-header")).toHaveLength(0);

    (buttons[0] as HTMLButtonElement).click();
    expect(action).toHaveBeenCalledOnce();
    // Clicking an item closes the menu, same as before this change.
    expect(document.querySelector(".popup-menu")).toBeNull();
  });

  it("preserves item order, interleaving section headers with items as given", () => {
    showMenu(anchor(), [
      { label: "Group A", header: true },
      { label: "A1" },
      { label: "A2" },
      { label: "Group B", header: true },
      { label: "B1" },
    ]);
    const menu = document.querySelector(".popup-menu")!;
    const rendered = Array.from(menu.children).map((el) =>
      el.classList.contains("popup-section-header") ? `H:${el.textContent}` : el.textContent,
    );
    expect(rendered).toEqual(["H:Group A", "A1", "A2", "H:Group B", "B1"]);
  });

  it("renders a header as a non-button <div>, not counted among clickable items", () => {
    showMenu(anchor(), [
      { label: "Group A", header: true },
      { label: "Item 1" },
    ]);
    const menu = document.querySelector(".popup-menu")!;
    const header = menu.querySelector(".popup-section-header");
    expect(header).not.toBeNull();
    expect(header!.tagName).toBe("DIV");
    expect(header!.textContent).toBe("Group A");
    expect(menu.querySelectorAll("button.popup-item")).toHaveLength(1);
    expect(header!.classList.contains("popup-item")).toBe(false);
  });

  it("never invokes a header's action and never closes the menu when a header is clicked", () => {
    // A header carrying an action/checked/disabled defensively exercises
    // that showMenu ignores all of it for header items, not just that no
    // caller happens to set them today.
    const headerAction = vi.fn();
    showMenu(anchor(), [
      { label: "Group A", header: true, action: headerAction, checked: true, disabled: true },
      { label: "Item 1" },
    ]);
    const header = document.querySelector(".popup-section-header") as HTMLElement;
    header.click();
    expect(headerAction).not.toHaveBeenCalled();
    // A real item click closes the menu (see the first test); a header
    // click must not, since it isn't a menu action at all.
    expect(document.querySelector(".popup-menu")).not.toBeNull();
  });

  it("gives a header no check column and no tabindex, so it sits outside the check/keyboard-focus model real items use", () => {
    showMenu(anchor(), [{ label: "Group A", header: true }]);
    const header = document.querySelector(".popup-section-header") as HTMLElement;
    expect(header.querySelector(".popup-check")).toBeNull();
    expect(header.hasAttribute("tabindex")).toBe(false);
    expect(header.hasAttribute("disabled")).toBe(false);
  });

  // Tab context menu (ROADMAP.md Track C) is the first real caller of a
  // disabled *item* (as opposed to a header) — Copy Path / Reveal in
  // Finder(Explorer) are disabled for untitled tabs. This locks down the
  // contract main.ts's showTabContextMenu relies on: a disabled item's
  // action never runs on click, and clicking it never closes the menu
  // (matching a real click on any other disabled control, and distinct
  // from a header, which also never closes the menu but for a different
  // reason — see "never invokes a header's action" above).
  it("disables an item: the button element carries `disabled`, and clicking it never invokes the action or closes the menu", () => {
    const action = vi.fn();
    showMenu(anchor(), [
      { label: "Enabled", action: vi.fn() },
      { label: "Disabled", disabled: true, action },
    ]);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".popup-menu button.popup-item");
    const disabledButton = buttons[1];
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.textContent).toContain("Disabled");

    disabledButton.click();
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector(".popup-menu")).not.toBeNull();
  });

  it("leaves an item enabled (no `disabled` attribute) when `disabled` is omitted or false", () => {
    showMenu(anchor(), [{ label: "A" }, { label: "B", disabled: false }]);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".popup-menu button.popup-item");
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(false);
  });
});

// Positioning (main.ts's status-bar pickers anchor near the bottom of the
// window; the tab-strip context menu — ROADMAP.md Track C — anchors near
// the top). jsdom's getBoundingClientRect() is all-zero by default, so
// each case here stubs the anchor's own rect explicitly (same technique as
// tabs.test.ts's stubRect) rather than relying on real layout.
describe("showMenu positioning", () => {
  function stubAnchorRect(el: HTMLElement, top: number, bottom: number): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 110,
      width: 100,
      top,
      bottom,
      height: bottom - top,
      x: 10,
      y: top,
      toJSON() {
        return {};
      },
    } as DOMRect);
  }

  it("opens upward (bottom-anchored) when the anchor is near the bottom of the window — existing status-bar-picker behavior", () => {
    const el = anchor();
    stubAnchorRect(el, window.innerHeight - 30, window.innerHeight - 10);
    showMenu(el, [{ label: "Item" }]);
    const menu = document.querySelector(".popup-menu") as HTMLElement;
    // Original formula, unchanged for this (more room above) branch:
    // bottom = distance from the viewport's bottom edge up to 6px above
    // the anchor's own top edge.
    expect(menu.style.bottom).toBe(`${window.innerHeight - (window.innerHeight - 30) + 6}px`);
    expect(menu.style.top).toBe("");
  });

  it("opens downward (top-anchored) when the anchor is near the top of the window — tab-strip context menu", () => {
    const el = anchor();
    stubAnchorRect(el, 8, 40);
    showMenu(el, [{ label: "Item" }]);
    const menu = document.querySelector(".popup-menu") as HTMLElement;
    expect(menu.style.top).toBe(`${40 + 6}px`);
    expect(menu.style.bottom).toBe("");
  });
});
