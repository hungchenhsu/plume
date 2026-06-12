// Minimal "Go to Line" prompt.
export function showGoToLine(onGo: (line: number) => void): void {
  if (document.querySelector(".goto-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "goto-overlay";
  const panel = document.createElement("div");
  panel.className = "goto-panel";

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "Go to line…";
  panel.appendChild(input);

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const line = Number.parseInt(input.value, 10);
      close();
      if (Number.isFinite(line) && line > 0) onGo(line);
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
