// Minimal single-instance popup menu anchored above a status bar control.
export interface MenuItem {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  action?: () => void;
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
      closeMenu();
      item.action?.();
    });
    el.appendChild(button);
  }

  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.bottom = `${window.innerHeight - rect.top + 6}px`;

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
