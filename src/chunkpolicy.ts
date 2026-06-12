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
