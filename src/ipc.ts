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
  /** Opaque metadata snapshot of the file as of this open (see
   *  src-tauri/src/fsguard.rs); store on the tab's `Doc.fingerprint` and
   *  pass back as `saveDocument`'s `expectedFingerprint` (issue #113). */
  fingerprint: unknown;
}

export interface DocumentChunk {
  content: string;
  offset: number;
  nextOffset: number | null;
  totalSize: number;
  malformed: boolean;
}

/**
 * What a forward chunk read's `offset` is — the Rust core applies
 * opposite alignment policies (src-tauri/src/chunk.rs `OffsetKind`,
 * issue #118): a `"continuation"` offset (the previous chunk's
 * `nextOffset`) is read exactly as given, mid-line when it continues a
 * line longer than one chunk; a `"lineStart"` offset (from the
 * possibly-stale line index behind goto/bookmarks) is defensively
 * realigned to the next real line start when it turns out not to be one.
 */
export type ChunkOffsetKind = "lineStart" | "continuation";

export function readDocumentChunk(
  path: string,
  offset: number,
  encoding: string,
  kind: ChunkOffsetKind,
): Promise<DocumentChunk> {
  return invoke<DocumentChunk>("read_document_chunk", {
    path,
    offset,
    encoding,
    kind,
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

/** One distinct unmappable character sample from a lossy-save rejection,
 *  carrying its first-occurrence position (src-tauri/src/normalize.rs's
 *  `UnmappableSample`). `line`/`column` are 1-based; `column` counts
 *  UTF-16 code units (matching CM6's own offsets, the same convention
 *  `onCursorMoved`/`statusbar.cursor` already use), not Unicode scalar
 *  values -- an astral character counts as 2. */
export interface LossySample {
  /** Formatted "char (U+XXXX)" text, e.g. "é (U+00E9)" — same convention as
   *  `RepresentabilityReport.samples`' entries. */
  display: string;
  line: number;
  column: number;
}

/** Which characters can't be represented in the target encoding, not just
 *  that some can't (ROADMAP.md v0.4 Track A "Lossy-save character preview";
 *  src-tauri/src/normalize.rs's `LossySaveReport`, shared scan technique
 *  with `RepresentabilityReport`/`checkRepresentable`). */
export interface LossyReport {
  /** Total count of Unicode scalar values with no representation in the
   *  target encoding — never capped, counted per occurrence. */
  unmappableCount: number;
  /** Up to 20 distinct unmappable characters, in first-encountered order,
   *  each with its own position (`normalize.rs`'s `SAMPLE_CAP`). */
  samples: LossySample[];
  /** True when there were more distinct unmappable characters than fit in
   *  `samples` — the dialog appends a note so a capped list is never
   *  mistaken for a complete one. */
  samplesTruncated: boolean;
}

export interface SaveResult {
  unmappable: boolean;
  written: boolean;
  /** True when `expectedFingerprint` was given and no longer matches the
   *  file's current on-disk state — something else wrote to this path
   *  since the fingerprint was captured. Nothing was written; re-invoke
   *  with `force: true` (after explicit user confirmation to overwrite) or
   *  reload the file's fresh content first (issue #113). */
  stale: boolean;
  /** Opaque fingerprint of the file immediately after a successful write —
   *  store it as the tab's new `Doc.fingerprint` for the next save. `null`
   *  unless `written` is true. */
  fingerprint: unknown;
  /** Populated only on the lossy-rejection path (`unmappable: true,
   *  written: false`, from the first, `allowLossy: false` call) — `null` on
   *  every other result (a successful write, lossy or not, and a `stale`
   *  rejection both have nothing new to show). See `showLossySaveConfirm`
   *  (src/lossysave.ts) for how this drives the confirm dialog. */
  lossyReport: LossyReport | null;
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
 * Multi-phase save. Call with `allowLossy: false` first. If the target
 * encoding can't represent some characters, the result comes back with
 * `unmappable: true` and `written: false` — nothing was written and the
 * file on disk is untouched. `lossyReport` names *which* characters and
 * *where* (ROADMAP.md v0.4 Track A "Lossy-save character preview") — see
 * `showLossySaveConfirm` (src/lossysave.ts). Re-invoke with `allowLossy:
 * true` (only after explicit user confirmation) to write the lossy bytes.
 *
 * Issue #113: `expectedFingerprint` (the tab's `Doc.fingerprint`, from the
 * last open/reload/save) is re-checked against the file's current on-disk
 * state right before the write commits. A mismatch — something else wrote
 * to this path since — comes back as `stale: true, written: false` with
 * nothing written; re-invoke with `force: true` only after the user
 * explicitly chooses to overwrite, or reload the file first. Pass `null`
 * for `expectedFingerprint` when there is no verified baseline yet (an
 * untitled document's first save, or Save As to a brand-new path) to skip
 * the check entirely. A call that actually writes (`written: true`) always
 * returns a fresh `fingerprint` to store as the baseline for the next save.
 */
export function saveDocument(args: {
  path: string;
  content: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  allowLossy: boolean;
  expectedFingerprint: unknown;
  force: boolean;
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
  /** User-toggled per-tab read-only lock (ROADMAP.md v0.4 Track C),
   *  restored on relaunch so a locked tab stays locked — see
   *  src-tauri/src/session.rs `SessionFile::user_read_only`. */
  userReadOnly: boolean;
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
  /** UI language: "system" | "en" | "zh-TW" | "ja" | "zh-CN". "system"
   *  resolves via navigator.language on the frontend (see src/i18n.ts
   *  effectiveLocale) and via the OS locale API on the Rust side for the
   *  native menu (see src-tauri/src/menu.rs). */
  language: string;
  defaultEncoding: string;
  defaultBom: boolean;
  wordWrap: boolean;
  showInvisibles: boolean;
  /** Indent-guide vertical lines (View menu, default on — see
   *  src/editor.ts `indentGuideLevels`/`setIndentGuides`). */
  indentGuides: boolean;
  /** Inline highlighting of the curated invisible/ambiguous character audit
   *  (View menu, default on — it's a trust feature, see ROADMAP.md v0.4
   *  Track A and src/editor.ts `setSuspiciousChars`). Only gates the inline
   *  highlight; the status-bar suspicious-character count is independent
   *  of this preference (see main.ts `computeAndShowSuspiciousChars`). */
  suspiciousChars: boolean;
  /** Fallback indent width (spaces-per-level / tab display width) used when
   *  per-buffer indentation detection can't confidently infer one — no
   *  indentation in the file, or an inconsistent tabs+spaces mix (ROADMAP.md
   *  v0.4 Track C; see src/indentdetect.ts `detectIndentation` and
   *  src/editor.ts `EditorHandle.setIndentation`). Also the tab *display*
   *  width for a tabs-indented file: unlike a spaces file's step, a tab's
   *  own visual width can never be inferred from the tab characters
   *  themselves, so detected "tabs" indentation always falls back to this
   *  value for `EditorState.tabSize` even though its `indentUnit` ("\t") is
   *  still confidently detected. Mirrors prefs.rs `indent_width: u32`. */
  indentWidth: number;
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

/** Re-check the View > Read-Only item after the active tab's effective
 *  read-only state changes (a toggle, or a tab switch — see main.ts's
 *  `syncReadOnlyState`, called from `showActive` and `toggleReadOnly`).
 *  `checked` is `isEffectivelyReadOnly(doc)`; `enabled` is `!doc.truncated`
 *  — a truncated large-file preview's read-only state can never be
 *  lifted, so its menu item is shown checked but disabled rather than
 *  left clickable (see menu.rs `sync_read_only_menu`). */
export function syncReadOnlyMenu(checked: boolean, enabled: boolean): Promise<void> {
  return invoke<void>("sync_read_only_menu", { checked, enabled });
}

/** Relabel the native menu's custom items (File/Edit/View submenus, and
 *  every `with_id` item inside them) to `locale`'s labels. Called whenever
 *  the resolved locale changes (Preferences dialog, or the "System"
 *  preference tracking an OS locale change). Best-effort like
 *  `syncThemeMenu`: if it fails, the frontend UI is already correct and the
 *  menu simply catches up on next relaunch. `locale` is "en" | "zh-TW" |
 *  "ja" | "zh-CN" — already resolved, never "system" (see src/i18n.ts
 *  effectiveLocale). */
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

export interface BatchScanError {
  /** The directory that couldn't be listed, or the specific entry whose
   *  metadata couldn't be read. */
  path: string;
  /** OS error text, e.g. "Permission denied (os error 13)". */
  message: string;
}

export interface BatchScanReport {
  entries: BatchEntry[];
  /** Directories or entries the scan could not read — each one means
   *  `entries` above may be missing whatever that path contained. Empty
   *  means the walk completed exhaustively; a non-empty list must never
   *  be treated as "no matching files there" (issue #116). The root
   *  folder itself failing to open is a harder failure than this — the
   *  `scanBatchConversion` call rejects outright instead of returning an
   *  empty-looking report. */
  scanErrors: BatchScanError[];
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
 * Rejects if the folder contains more than 2000 matching files, or if the
 * folder itself can't be listed at all (issue #116) — see
 * `BatchScanReport.scanErrors` for entries the walk still partially
 * missed after that point.
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

export interface StreamConvertReport {
  /** False only on the lossy-rejection branch (`lossyReport` populated,
   *  unmappable characters found and `allowLossy` was false) — nothing was
   *  written and the file on disk is exactly as it was. */
  written: boolean;
  bytesWritten: number;
  /** Populated only when `written` is false — same shape `saveDocument`'s
   *  own lossy rejection uses (`LossyReport`), so `showLossySaveConfirm`
   *  (src/lossysave.ts) drives this exactly like the regular save path's
   *  lossy gate. `null` on every other result. */
  lossyReport: LossyReport | null;
}

/**
 * Convert an entire file on disk from `sourceEncoding` to
 * `targetEncoding`/`targetWithBom`, streamed in bounded chunks on the Rust
 * side (see src-tauri/src/streamconvert.rs) so memory use stays flat
 * regardless of file size — the large-file preview window's equivalent of
 * "Save with Encoding", since only a bounded slice of the file is ever
 * loaded into the editor. `sourceEncoding` should be the document's own
 * detected encoding (`doc.encoding`), used to decode; this never guesses.
 *
 * Call with `allowLossy: false` first. If `targetEncoding` can't represent
 * some characters, the result comes back with `written: false` and a
 * populated `lossyReport` (identical shape to `saveDocument`'s own — see
 * `showLossySaveConfirm`), and the file on disk is left untouched.
 * Re-invoke with `allowLossy: true` (only after explicit user confirmation)
 * to write the lossy bytes — this re-streams the whole file again, since
 * the first call's work was discarded rather than committed.
 *
 * Rejects for a UTF-16LE/BE *target* encoding (no streaming UTF-16 encoder
 * — see the Rust module doc comment); a UTF-16 *source* is fully
 * supported, decoded through the ordinary streaming decoder.
 */
export function streamConvertFile(
  path: string,
  sourceEncoding: string,
  targetEncoding: string,
  targetWithBom: boolean,
  allowLossy: boolean,
): Promise<StreamConvertReport> {
  return invoke<StreamConvertReport>("stream_convert_file", {
    path,
    sourceEncoding,
    targetEncoding,
    targetWithBom,
    allowLossy,
  });
}

export interface EncodeCharResult {
  /** Uppercase, space-separated hex byte pairs, e.g. "E4 B8 AD". Empty
   *  when `lossy` is true — never encoding_rs's own HTML numeric-character-
   *  reference fallback bytes (see src-tauri/src/charinspect.rs). */
  bytesHex: string;
  /** True when `ch` has no representation in `encoding` at all. */
  lossy: boolean;
}

/**
 * Encode a single character (`ch` must be exactly one Unicode code point —
 * see src/editor.ts's `characterBeforeCursor`) to its byte sequence under
 * `encoding`, for the status-bar character-inspector popup (ROADMAP.md v0.4
 * Track A). Read-only and side-effect free: never touches disk. There is no
 * `withBom` parameter — a BOM is a file-level, offset-0-only marker, not a
 * property of one character's bytes. UTF-16LE/BE are hand-encoded on the
 * Rust side rather than going through `encoding_rs`'s `new_encoder()` (see
 * the Rust module doc comment for the known dead end this avoids).
 */
export function encodeChar(ch: string, encoding: string): Promise<EncodeCharResult> {
  return invoke<EncodeCharResult>("encode_char", { ch, encoding });
}

export interface RepresentabilityReport {
  /** Total count of Unicode scalar values with no representation in the
   *  target encoding — never capped, counted per occurrence. */
  unmappableCount: number;
  /** Up to 20 formatted samples of *distinct* unmappable characters, e.g.
   *  "é (U+00E9)", in first-encountered order (src-tauri/src/normalize.rs's
   *  `SAMPLE_CAP`); a repeated character contributes one entry. */
  samples: string[];
  /** True when there were more distinct unmappable characters than fit in
   *  `samples` — the warning dialog appends an "and more" note so a capped
   *  list is never mistaken for a complete one. */
  samplesTruncated: boolean;
}

/**
 * Representability dry-run for Edit > Normalize to NFC/NFD (ROADMAP.md v0.4
 * Track A) [danger]: before the frontend applies a normalization to the
 * live buffer, check whether `text` (the *result* of normalizing) can still
 * be losslessly saved as `encoding` — mirroring `save_document`'s own
 * two-phase lossy-encode gate, run one step earlier. See main.ts's
 * `runNormalizeFlow` for the full confirm-then-check-then-apply flow, and
 * src-tauri/src/normalize.rs's module doc for why this matters: NFD's
 * decomposed combining sequences are frequently unrepresentable in legacy
 * encodings even when the precomposed NFC form was fine. Callers should
 * skip this call entirely for UTF-8/UTF-16 documents (every Unicode scalar
 * value is representable in either, so the round trip can only ever come
 * back clean) — see main.ts's `isUnicodeEncoding`.
 */
export function checkRepresentable(
  text: string,
  encoding: string,
): Promise<RepresentabilityReport> {
  return invoke<RepresentabilityReport>("check_representable", { text, encoding });
}
