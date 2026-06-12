// Policy for continuous reading of large files: when to auto-append the
// next chunk as the user scrolls, and when to stop and fall back to the
// manual jump pager.

/** Auto-append stops once this many chunks are loaded (~64 MB of text). */
export const MAX_AUTO_CHUNKS = 32;

/** Distance (in characters) from the document end that counts as "near". */
export const NEAR_END_MARGIN = 1000;

export function nearEnd(viewportTo: number, docLength: number): boolean {
  return viewportTo >= docLength - NEAR_END_MARGIN;
}

export function canAutoAppend(state: {
  loadedChunks: number;
  nextOffset: number | null;
  inFlight: boolean;
}): boolean {
  return (
    !state.inFlight &&
    state.nextOffset !== null &&
    state.loadedChunks < MAX_AUTO_CHUNKS
  );
}
