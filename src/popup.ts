// Minimal single-instance popup menu anchored above a status bar control.
export interface MenuItem {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  action?: () => void;
  /** Render `label` as a non-interactive section header (e.g. the encoding
   *  picker's Unicode/East Asian/… groups) instead of a clickable item.
   *  `checked` / `disabled` / `action` are ignored when this is true.
   *  Optional and defaulting to falsy, so every pre-existing `showMenu`
   *  caller (line-ending menu, decode-warning menu, the top-level encoding
   *  menu, etc.) needs no changes. */
  header?: boolean;
}

interface OpenMenu {
  el: HTMLElement;
  onAway: (event: MouseEvent) => void;
  onKey: (event: KeyboardEvent) => void;
}

let current: OpenMenu | null = null;

export function closeMenu(): void {
  if (!current) return;
  document.removeEventListener("mousedown", current.onAway);
  document.removeEventListener("keydown", current.onKey);
  current.el.remove();
  current = null;
}

export function showMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const el = document.createElement("div");
  el.className = "popup-menu";

  for (const item of items) {
    if (item.header) {
      const headerEl = document.createElement("div");
      headerEl.className = "popup-section-header";
      headerEl.textContent = item.label;
      el.appendChild(headerEl);
      continue;
    }

    const button = document.createElement("button");
    button.className = "popup-item";
    button.disabled = item.disabled ?? false;

    const check = document.createElement("span");
    check.className = "popup-check";
    check.textContent = item.checked ? "✓" : "";
    button.appendChild(check);

    const label = document.createElement("span");
    label.textContent = item.label;
    button.appendChild(label);

    button.addEventListener("click", () => {
      // Belt-and-suspenders alongside the native `disabled` attribute set
      // above (which already suppresses the browser's own click dispatch
      // on a disabled button in every real WebView/jsdom): an explicit
      // guard here doesn't depend on that platform behavior being uniform.
      if (item.disabled) return;
      closeMenu();
      item.action?.();
    });
    el.appendChild(button);
  }

  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;

  // Every pre-existing caller anchors to a status-bar control near the
  // bottom of the window, where opening upward (bottom-anchored, growing
  // toward the top) is correct and is all this once did unconditionally.
  // A trigger nearer the top of the window instead — e.g. the tab-strip
  // context menu (main.ts's showTabContextMenu) — needs the opposite: open
  // downward from the anchor's own bottom edge, or the menu would render
  // with its top edge above the viewport's own top edge (bottom-anchored
  // position math with no explicit `top` grows upward from the anchor with
  // no lower bound). Picking whichever side has more room keeps every
  // existing caller's behavior byte-for-byte unchanged (they all have more
  // room above than below) while making the container correct for a new
  // top-anchored caller too.
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow > spaceAbove) {
    el.style.top = `${rect.bottom + 6}px`;
  } else {
    el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  }

  const onAway = (event: MouseEvent) => {
    if (!el.contains(event.target as Node)) closeMenu();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeMenu();
  };
  current = { el, onAway, onKey };
  // Deferred so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}
