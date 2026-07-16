// Policy for continuous reading of large files: when to load another chunk
// as the user scrolls. The window itself stays bounded via trimming (see
// chunkwindow.ts), so neither direction has a hard stop anymore.

/** Distance (in characters) from the document end that counts as "near". */
export const NEAR_END_MARGIN = 1000;

export function nearEnd(viewportTo: number, docLength: number): boolean {
  return viewportTo >= docLength - NEAR_END_MARGIN;
}

export function canAutoAppend(state: {
  nextOffset: number | null;
  inFlight: boolean;
}): boolean {
  return !state.inFlight && state.nextOffset !== null;
}

export function nearStart(viewportFrom: number): boolean {
  return viewportFrom <= NEAR_END_MARGIN;
}

export function canPrepend(state: {
  windowStart: number;
  inFlight: boolean;
}): boolean {
  return !state.inFlight && state.windowStart > 0;
}

/** Encodings chunk paging cannot support, mirrored from the same gate
 *  `chunk.rs`'s `read_document_chunk`/`read_document_chunk_before` enforce
 *  at the command layer (the frontend gate here only spares a doomed IPC
 *  round trip; the Rust side is the real guard):
 *  - UTF-16LE/BE: chunks cannot be line-aligned by a lone-0x0A byte search
 *    (UTF-16's LF is a two-byte code unit).
 *  - ISO-2022-JP (issue #225): the one encoding_rs decoder that is
 *    genuinely stateful. Each chunk request decodes with a brand new
 *    decoder that has no memory of the previous page's JIS shift state, so
 *    a raw cut landing inside a shift sequence lets the *next* page
 *    silently misdecode well-formed-looking-but-wrong text with no
 *    malformed signal.
 *  `doc.encoding` is always a canonical encoding_rs name as reported back
 *  by the Rust core (see encodings.ts), so exact/prefix string comparisons
 *  against these canonical names are safe here — there is no free-form
 *  label to normalize on this side of the IPC boundary. */
function pagingUnsupportedEncoding(encoding: string): boolean {
  return encoding.startsWith("UTF-16") || encoding === "ISO-2022-JP";
}

/** UTF-16 and ISO-2022-JP chunks cannot be safely paged; paging is
 *  disabled for them (see `pagingUnsupportedEncoding`). */
export function pagingSupported(doc: { truncated: boolean; encoding: string }): boolean {
  return doc.truncated && !pagingUnsupportedEncoding(doc.encoding);
}
