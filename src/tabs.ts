import type { EditorBuffer } from "./editor";

export interface Doc {
  id: number;
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
  dirty: boolean;
  buffer: EditorBuffer;
}

export interface TabEvents {
  onSelect(id: number): void;
  onClose(id: number): void;
  onNew(): void;
}

export class TabStore {
  docs: Doc[] = [];
  activeId: number | null = null;

  constructor(
    private container: HTMLElement,
    private events: TabEvents,
  ) {}

  get active(): Doc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  get(id: number): Doc | null {
    return this.docs.find((d) => d.id === id) ?? null;
  }

  findByPath(path: string): Doc | null {
    return this.docs.find((d) => d.path === path) ?? null;
  }

  add(doc: Doc): void {
    this.docs.push(doc);
    this.activeId = doc.id;
  }

  setActive(id: number): void {
    if (this.get(id)) this.activeId = id;
  }

  /** Remove a tab. If it was active, a neighbor becomes active. */
  close(id: number): void {
    const index = this.docs.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.docs.splice(index, 1);
    if (this.activeId === id) {
      const neighbor = this.docs[index] ?? this.docs[index - 1];
      this.activeId = neighbor?.id ?? null;
    }
  }

  /** Move activation by offset (+1 next, -1 previous), wrapping around. */
  cycle(offset: number): void {
    if (this.docs.length < 2 || this.activeId === null) return;
    const index = this.docs.findIndex((d) => d.id === this.activeId);
    const next = (index + offset + this.docs.length) % this.docs.length;
    this.activeId = this.docs[next].id;
  }

  render(): void {
    this.container.replaceChildren();
    for (const doc of this.docs) {
      const tab = document.createElement("div");
      tab.className = doc.id === this.activeId ? "tab active" : "tab";
      tab.addEventListener("mousedown", () => this.events.onSelect(doc.id));

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = doc.title;
      if (doc.path) tab.title = doc.path;
      tab.appendChild(title);

      const close = document.createElement("button");
      close.className = doc.dirty ? "tab-close dirty" : "tab-close";
      close.textContent = doc.dirty ? "●" : "×";
      close.ariaLabel = `Close ${doc.title}`;
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      close.addEventListener("click", () => this.events.onClose(doc.id));
      tab.appendChild(close);

      this.container.appendChild(tab);
    }

    const add = document.createElement("button");
    add.className = "tab-new";
    add.textContent = "+";
    add.ariaLabel = "New tab";
    add.addEventListener("click", () => this.events.onNew());
    this.container.appendChild(add);
  }
}
