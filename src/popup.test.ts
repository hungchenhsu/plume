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
});
