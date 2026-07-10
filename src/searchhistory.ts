// Find/replace MRU history. Pure logic, zero CodeMirror dependency — the
// editor module (src/editor.ts) is the only place allowed to import CM6 and
// wires this store into the search panel's DOM. See ARCHITECTURE.md on
// keeping the editor surface swappable.

const STORAGE_KEY = "plume.searchHistory.v1";
const MAX_ENTRIES = 20;

/** Minimal storage contract — matches the DOM `Storage` interface. */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredShape {
  find: string[];
  replace: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNonEmptyString).slice(0, MAX_ENTRIES);
}

/** Move `term` to the front of `list`, deduping and capping at MAX_ENTRIES. */
function pushMru(list: readonly string[], term: string): string[] {
  if (term === "") return [...list];
  const deduped = list.filter((existing) => existing !== term);
  deduped.unshift(term);
  return deduped.slice(0, MAX_ENTRIES);
}

/**
 * Probe `localStorage` for availability. Some environments (privacy mode,
 * disabled storage, non-browser test runners) throw on access or on
 * read/write — any failure here means "degrade to memory-only", never a
 * thrown error surfaced to the caller.
 */
function detectStorage(): HistoryStorage | null {
  try {
    const storage = window.localStorage;
    const probeKey = "__plume_search_history_probe__";
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

export class SearchHistory {
  private find: string[] = [];
  private replace: string[] = [];
  private storage: HistoryStorage | null;

  /**
   * `storage` defaults to an auto-detected `localStorage`. Pass `null`
   * explicitly (or a stub) to control persistence in tests.
   */
  constructor(storage: HistoryStorage | null | undefined = detectStorage()) {
    this.storage = storage;
    this.load();
  }

  findTerms(): readonly string[] {
    return this.find;
  }

  replaceTerms(): readonly string[] {
    return this.replace;
  }

  pushFind(term: string): void {
    this.find = pushMru(this.find, term);
    this.persist();
  }

  pushReplace(term: string): void {
    this.replace = pushMru(this.replace, term);
    this.persist();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredShape>;
      this.find = sanitizeList(parsed.find);
      this.replace = sanitizeList(parsed.replace);
    } catch {
      // Corrupt JSON or a storage read failure — start from an empty,
      // in-memory history rather than throwing.
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const payload: StoredShape = { find: this.find, replace: this.replace };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage failed mid-session (quota, disabled, etc.) — keep working
      // in memory for the rest of this session instead of throwing.
      this.storage = null;
    }
  }
}

/** Shared instance used by the editor module's search panel wiring. */
export const searchHistory = new SearchHistory();

export function pushFindTerm(term: string): void {
  searchHistory.pushFind(term);
}

export function pushReplaceTerm(term: string): void {
  searchHistory.pushReplace(term);
}

export function findHistory(): readonly string[] {
  return searchHistory.findTerms();
}

export function replaceHistory(): readonly string[] {
  return searchHistory.replaceTerms();
}
