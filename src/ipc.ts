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

export interface LineIndex {
  /** `checkpoints[k]` is the byte offset of line `k * 1024` (0-based). */
  checkpoints: number[];
  totalLines: number;
  /** File size when the index was built; compare against `doc.totalSize`
   *  to detect a stale index (see src-tauri/src/lineindex.rs). */
  indexedSize: number;
}

/**
 * Build a sparse line-offset index for a large file by streaming it once
 * (see src-tauri/src/lineindex.rs) — used for go-to-line and bookmarks
 * beyond the currently loaded chunk window. `encoding` should be the
 * document's own detected encoding (`doc.encoding`); rejects for UTF-16
 * files, mirroring `readDocumentChunk`'s paging exclusion.
 */
export function buildLineIndex(path: string, encoding: string): Promise<LineIndex> {
  return invoke<LineIndex>("build_line_index", { path, encoding });
}

/**
 * Resolve the byte offset of `targetLine`'s first byte by streaming from
 * `fromOffset` (the byte offset of `fromLine`'s first byte — normally a
 * `LineIndex` checkpoint). Both line numbers are 0-based. Rejects if
 * `targetLine` is before `fromLine`; clamps to the last line's start
 * (never errors) if the file ends before `targetLine` is reached.
 */
export function locateLineOffset(
  path: string,
  targetLine: number,
  fromOffset: number,
  fromLine: number,
): Promise<number> {
  return invoke<number>("locate_line_offset", {
    path,
    targetLine,
    fromOffset,
    fromLine,
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

/** Every backup file name currently on disk under backups/, regardless of
 *  whether any session entry references it. Used to recover orphaned
 *  backups when the session index is missing or stale (see orphans.ts). */
export function listBackups(): Promise<string[]> {
  return invoke<string[]>("list_backups");
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

export interface RepairCandidate {
  /** The wrong encoding the bytes were mis-decoded with, e.g. "windows-1252". */
  intermediate: string;
  /** The encoding the bytes actually are, e.g. "Big5". */
  original: string;
  /** First ~200 characters of the repaired text. */
  preview: string;
  /** Heuristic count of characters this repair would change. */
  replacementCount: number;
}

/**
 * Detect candidate mojibake repairs for `content` (the live editor text).
 * Read-only and side-effect free: samples at most 64 KiB, never touches
 * disk. Returns at most 5 candidates, strongest first; an empty array means
 * no mis-decode pattern was found.
 */
export function detectMojibake(content: string): Promise<RepairCandidate[]> {
  return invoke<RepairCandidate[]>("detect_mojibake", { content });
}

/**
 * Apply one mojibake repair over the *entire* document text (never just the
 * detection sample), returning the repaired text. Rejects with a readable
 * error — instead of returning something silently wrong — if a character in
 * the full text can't round-trip through `intermediate`/`original`, e.g.
 * because the detection sample missed an exception elsewhere in the file.
 * Never touches disk; the caller decides what to do with the result (the
 * wizard puts it in the editor buffer as an unsaved, undoable change).
 */
export function applyMojibakeRepair(
  content: string,
  intermediate: string,
  original: string,
): Promise<string> {
  return invoke<string>("apply_mojibake_repair", {
    content,
    intermediate,
    original,
  });
}

export interface BatchEntry {
  path: string;
  /** Detected source encoding name, e.g. "Big5". Empty for `tooLarge`. */
  detected: string;
  /** "convertible" | "alreadyTarget" | "lossy" | "undecodable" | "tooLarge" */
  status: string;
  /** The file's own detected line ending: "LF" | "CRLF" | "Mixed". Empty
   *  for `tooLarge` or a file whose bytes couldn't be read at all. */
  lineEnding: string;
}

export interface BatchScanReport {
  entries: BatchEntry[];
}

/**
 * Dry-run scan of `dir` for batch encoding/line-ending conversion:
 * classifies every matching file against `targetEncoding`/`targetWithBom`
 * (the encoding axis) and `lineEnding` (the line-ending axis) without
 * changing anything on disk. `targetEncoding` is a canonical encoding name
 * or the sentinel `"keep"` (leave each file's own encoding alone —
 * `targetWithBom` is then ignored). `lineEnding` is one of `"keep"` |
 * `"LF"` | `"CRLF"`. `extensions` is a list of lowercase, dot-less
 * extensions (e.g. ["txt", "md"]); an empty list matches every file.
 * Rejects if the folder contains more than 2000 matching files.
 */
export function scanBatchConversion(
  dir: string,
  extensions: string[],
  targetEncoding: string,
  targetWithBom: boolean,
  lineEnding: string,
): Promise<BatchScanReport> {
  return invoke<BatchScanReport>("scan_batch_conversion", {
    dir,
    extensions,
    targetEncoding,
    targetWithBom,
    lineEnding,
  });
}

export interface BatchConvertResult {
  path: string;
  ok: boolean;
  message: string;
}

/**
 * Convert every path in `paths` to `targetEncoding`/`withBom` (or leave
 * each file's own encoding alone with `targetEncoding: "keep"`), unifying
 * line endings per `lineEnding` (`"keep"` | `"LF"` | `"CRLF"`), one atomic
 * write per file. Never trusts a prior scan's snapshot — each file is
 * re-detected and re-decoded fresh from disk; a file that no longer
 * decodes cleanly or would lose data under the target encoding comes back
 * with `ok: false` and is left untouched. One file's failure never stops
 * the rest of the batch.
 */
export function executeBatchConversion(
  paths: string[],
  targetEncoding: string,
  withBom: boolean,
  lineEnding: string,
): Promise<BatchConvertResult[]> {
  return invoke<BatchConvertResult[]>("execute_batch_conversion", {
    paths,
    targetEncoding,
    withBom,
    lineEnding,
  });
}

export interface EncodingPreviewSide {
  /** Canonical encoding name actually used to decode, e.g. "Big5". */
  encoding: string;
  /** Decoded text, truncated to at most 4000 characters. */
  content: string;
  malformed: boolean;
}

export interface TwoEncodingPreview {
  a: EncodingPreviewSide;
  b: EncodingPreviewSide;
  /** How many bytes were actually read from disk (at most 64 KiB). */
  sampledBytes: number;
  totalSize: number;
}

/**
 * Decode a bounded prefix (at most 64 KiB) of `path` under two candidate
 * encodings side by side, for manual disambiguation when automatic
 * detection can't confidently choose between look-alike legacy encodings
 * (e.g. Big5 vs GBK). Read-only and side-effect free — raw bytes never
 * cross IPC, only the decoded text. Rejects if either label is not a known
 * encoding.
 */
export function previewTwoEncodings(
  path: string,
  encodingA: string,
  encodingB: string,
): Promise<TwoEncodingPreview> {
  return invoke<TwoEncodingPreview>("preview_two_encodings", {
    path,
    encodingA,
    encodingB,
  });
}

export interface StreamReplaceReport {
  replacements: number;
  bytesWritten: number;
}

/**
 * Search-and-replace across an entire file on disk, streamed in bounded
 * chunks on the Rust side so memory use stays flat regardless of file size
 * (see src-tauri/src/streamreplace.rs) — the large-file preview window's
 * equivalent of Find/Replace, since only a bounded slice of a large file is
 * ever loaded into the editor and saving that slice back would destroy the
 * rest of the file. `encoding` should be the document's own detected
 * encoding (`doc.encoding`); this never converts between encodings. Zero
 * matches, or any error, leaves the file completely untouched — the caller
 * only needs to reload the document from disk when `replacements > 0`.
 * Rejects for UTF-16 files (no streaming UTF-16 encoder — see the Rust
 * module doc comment) and when `search` is empty.
 */
export function streamReplaceInFile(
  path: string,
  search: string,
  replace: string,
  encoding: string,
  caseSensitive: boolean,
): Promise<StreamReplaceReport> {
  return invoke<StreamReplaceReport>("stream_replace_in_file", {
    path,
    search,
    replace,
    encoding,
    caseSensitive,
  });
}
