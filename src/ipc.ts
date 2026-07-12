// Typed wrappers around the Rust core's Tauri commands. All disk I/O goes
// through here; the frontend never touches raw bytes.
import { invoke } from "@tauri-apps/api/core";

export interface OpenedDocument {
  path: string;
  content: string;
  encoding: string;
  hadBom: boolean;
  malformed: boolean;
  lineEnding: string;
  /** Only a leading slice of a large file was loaded; treat as read-only. */
  truncated: boolean;
  totalSize: number;
  /** When truncated: file offset where the next chunk begins. */
  nextOffset: number | null;
}

export interface DocumentChunk {
  content: string;
  offset: number;
  nextOffset: number | null;
  totalSize: number;
  malformed: boolean;
}

export function readDocumentChunk(
  path: string,
  offset: number,
  encoding: string,
): Promise<DocumentChunk> {
  return invoke<DocumentChunk>("read_document_chunk", {
    path,
    offset,
    encoding,
  });
}

/** Read the chunk that ends exactly at `end` (backward window extension). */
export function readDocumentChunkBefore(
  path: string,
  end: number,
  encoding: string,
): Promise<DocumentChunk> {
  return invoke<DocumentChunk>("read_document_chunk_before", {
    path,
    end,
    encoding,
  });
}

export interface SaveResult {
  unmappable: boolean;
  written: boolean;
}

/**
 * `extensionEncoding` is the per-extension default from the preferences
 * table (see extensionEncodings.ts), forwarded as a hint for
 * auto-detection. The Rust core only honors it when the file has no BOM,
 * is not valid non-ASCII UTF-8 (confident UTF-8 always wins), and the
 * hinted encoding decodes the bytes without malformed sequences; it is
 * ignored entirely when an explicit `encoding` is passed.
 */
export function openDocument(
  path: string,
  encoding?: string,
  extensionEncoding?: string,
): Promise<OpenedDocument> {
  return invoke<OpenedDocument>("open_document", {
    path,
    encoding,
    extensionEncoding,
  });
}

export interface DetectionExplanation {
  /** e.g. "UTF-8 BOM (EF BB BF)"; null when no BOM was found. */
  bom: string | null;
  /** chardetng's verdict on the sampled bytes. */
  detectorVerdict: string;
  sampledBytes: number;
  totalSize: number;
  /** "{encoding} ({reason})", reason is "bom" | "extension" | "detector"
   *  | "fallback". */
  wouldChoose: string;
}

/**
 * Diagnostics for the "Why {encoding}?" status-bar popup: re-reads a bounded
 * prefix of the file and reruns the same detection `open_document` uses,
 * without decoding or affecting the open document. Read-only, side-effect
 * free. Pass the same `extensionEncoding` hint `openDocument` would get so
 * the card reflects the per-extension preference decision.
 */
export function explainDetection(
  path: string,
  extensionEncoding?: string,
): Promise<DetectionExplanation> {
  return invoke<DetectionExplanation>("explain_detection", {
    path,
    extensionEncoding,
  });
}

/**
 * Two-phase save: call with `allowLossy: false` first. If the target
 * encoding can't represent some characters, the result comes back with
 * `unmappable: true` and `written: false` — nothing was written and the
 * file on disk is untouched. Re-invoke with `allowLossy: true` (only after
 * explicit user confirmation) to write the lossy bytes; that call always
 * has `written: true`.
 */
export function saveDocument(args: {
  path: string;
  content: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  allowLossy: boolean;
}): Promise<SaveResult> {
  return invoke<SaveResult>("save_document", args);
}

export interface SessionFile {
  /** Null for untitled documents kept alive by a hot-exit backup. */
  path: string | null;
  encoding: string;
  /** Cursor position as a character offset. */
  cursor: number;
  /** Backup file name holding unsaved content, if any. */
  backup: string | null;
  title: string;
  withBom: boolean;
  lineEnding: string;
}

export interface SessionData {
  files: SessionFile[];
  active: number;
}

export function loadSession(): Promise<SessionData | null> {
  return invoke<SessionData | null>("load_session");
}

export function saveSession(session: SessionData): Promise<void> {
  return invoke<void>("save_session", { session });
}

export interface Preferences {
  fontFamily: string;
  fontSize: number;
  theme: string;
  /** UI language: "system" | "en" | "zh-TW". "system" resolves via
   *  navigator.language on the frontend (see src/i18n.ts effectiveLocale)
   *  and via the OS locale API on the Rust side for the native menu (see
   *  src-tauri/src/menu.rs). */
  language: string;
  defaultEncoding: string;
  defaultBom: boolean;
  wordWrap: boolean;
  showInvisibles: boolean;
  /** Per-extension default encodings, e.g. [["txt", "Big5"]]. Extensions
   *  are lowercase without a leading dot (see extensionEncodings.ts);
   *  mirrors prefs.rs `extension_encodings: Vec<(String, String)>`. */
  extensionEncodings: [string, string][];
}

export function loadPreferences(): Promise<Preferences> {
  return invoke<Preferences>("load_preferences");
}

export function savePreferences(preferences: Preferences): Promise<void> {
  return invoke<void>("save_preferences", { preferences });
}

/** Re-check the matching entry in the View > Theme menu (a native radio
 *  group) after the theme changes from either the menu itself or the
 *  Preferences dialog. `theme` is one of the values in preferences.ts
 *  THEMES ("system" | "light" | "dark" | "paper" | "dusk"). */
export function syncThemeMenu(theme: string): Promise<void> {
  return invoke<void>("sync_theme_menu", { theme });
}

/** Relabel the native menu's custom items (File/Edit/View submenus, and
 *  every `with_id` item inside them) to `locale`'s labels. Called whenever
 *  the resolved locale changes (Preferences dialog, or the "System"
 *  preference tracking an OS locale change). Best-effort like
 *  `syncThemeMenu`: if it fails, the frontend UI is already correct and the
 *  menu simply catches up on next relaunch. `locale` is "en" | "zh-TW" —
 *  already resolved, never "system" (see src/i18n.ts effectiveLocale). */
export function retitleMenu(locale: string): Promise<void> {
  return invoke<void>("retitle_menu", { locale });
}

/** Files queued by the OS (file association / CLI) before startup. */
export function takePendingFiles(): Promise<string[]> {
  return invoke<string[]>("take_pending_files");
}

export function saveBackup(name: string, content: string): Promise<void> {
  return invoke<void>("save_backup", { name, content });
}

export function loadBackup(name: string): Promise<string | null> {
  return invoke<string | null>("load_backup", { name });
}

export function deleteBackup(name: string): Promise<void> {
  return invoke<void>("delete_backup", { name });
}

export function watchFile(path: string): Promise<void> {
  return invoke<void>("watch_file", { path });
}

export function loadRecentFiles(): Promise<string[]> {
  return invoke<string[]>("load_recent_files");
}

/** Push a path onto the recent list; returns the updated list. */
export function addRecentFile(path: string): Promise<string[]> {
  return invoke<string[]>("add_recent_file", { path });
}

export interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface SearchResults {
  matches: SearchMatch[];
  truncated: boolean;
  filesScanned: number;
}

export function searchInFolder(
  folder: string,
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
): Promise<SearchResults> {
  return invoke<SearchResults>("search_in_folder", {
    folder,
    query,
    caseSensitive,
    useRegex,
  });
}

export function unwatchFile(path: string): Promise<void> {
  return invoke<void>("unwatch_file", { path });
}

/** Open the native print dialog (the print view must be filled first). */
export function printWindow(): Promise<void> {
  return invoke<void>("print_window");
}

export interface HexDumpResult {
  /** Classic hex dump text, already formatted by the Rust core. */
  text: string;
  totalSize: number;
  shownBytes: number;
}

/**
 * Read-only hex/bytes preview for a file that failed to decode as text.
 * Raw bytes never cross IPC: the Rust core formats them into `text` before
 * returning. `maxBytes` is a request, not a guarantee — the core caps it.
 */
export function readHexDump(
  path: string,
  maxBytes: number,
): Promise<HexDumpResult> {
  return invoke<HexDumpResult>("read_hex_dump", { path, maxBytes });
}

/**
 * Signals that frontend startup finished (preferences, session, pending
 * files). No-op unless the `PLUME_STARTUP_PROBE` env var is set on the
 * Rust side — see `scripts/startup-bench.mjs`.
 */
export function reportStartupReady(): Promise<void> {
  return invoke<void>("report_startup_ready");
}
