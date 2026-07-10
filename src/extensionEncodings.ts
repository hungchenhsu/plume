// Pure logic for the per-extension default-encoding preference: extension
// normalization, table dedupe, and path -> encoding lookup. No DOM and no
// IPC here so it is unit-testable (see extensionEncodings.test.ts).
//
// The table is stored in preferences as `[extension, encoding][]` with the
// extension lowercase and without a leading dot — the same shape the Rust
// side declares in prefs.rs (`extension_encodings: Vec<(String, String)>`).
// The encoding value is a canonical encoding_rs name from encodings.ts.
//
// The entry is only a *hint*: the Rust core ignores it when the file has a
// BOM or when decoding the bytes with it would produce malformed output
// (see encoding.rs `detect_with_extension`), so a wrong mapping can never
// force mojibake.

export type ExtensionEncodingEntry = [extension: string, encoding: string];

/**
 * Normalize a user-typed extension: trim, drop leading dots ("*.txt",
 * ".txt" and "txt" all mean txt), lowercase. Returns null when nothing
 * usable remains (empty, dots only, or inner whitespace/path separators —
 * an extension is a single path-less token).
 */
export function normalizeExtension(input: string): string | null {
  const trimmed = input.trim().replace(/^\*?\.+/, "");
  if (trimmed === "") return null;
  if (/[\s./\\]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Normalize a whole table as edited in the Preferences dialog: normalize
 * each extension, drop rows with unusable extensions or empty encodings,
 * and dedupe so each extension appears once (the last row wins — it is the
 * user's most recent edit).
 */
export function normalizeTable(
  rows: { extension: string; encoding: string }[],
): ExtensionEncodingEntry[] {
  const map = new Map<string, string>();
  for (const row of rows) {
    const ext = normalizeExtension(row.extension);
    if (ext === null || row.encoding === "") continue;
    // Re-inserting must move the entry to the back so "last wins" also
    // shows in the resulting order.
    map.delete(ext);
    map.set(ext, row.encoding);
  }
  return [...map.entries()];
}

/** Lowercase extension of `path` without the dot, or null when there is
 *  none (no dot, dotfile like ".gitignore", or trailing dot). */
export function extensionOf(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * The encoding the table maps `path`'s extension to, or undefined when the
 * path has no extension or no entry matches. This is what gets forwarded
 * to the Rust core as the `extensionEncoding` hint.
 */
export function lookupExtensionEncoding(
  table: ExtensionEncodingEntry[],
  path: string,
): string | undefined {
  const ext = extensionOf(path);
  if (ext === null) return undefined;
  return table.find(([entryExt]) => entryExt === ext)?.[1];
}
