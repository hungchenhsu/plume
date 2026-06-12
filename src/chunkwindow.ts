// Sliding-window bookkeeping for large-file reading. Each loaded chunk is
// tracked with two lengths: `chars` (CodeMirror document positions, after
// LF normalization) and `bytes` (raw file bytes consumed, for file-offset
// math). They differ for multi-byte encodings and CRLF files, so both must
// be carried — trimming uses chars against the editor and bytes against
// the window's file offsets.

/** Window budget; with trimming the window never grows past this. */
export const WINDOW_MAX_CHUNKS = 8;

export interface WindowChunk {
  chars: number;
  bytes: number;
}

export interface TrimInstruction {
  trimChars: number;
  trimBytes: number;
}

/** Add a chunk at the end; over budget, the first chunk must be trimmed. */
export function pushBack(
  window: WindowChunk[],
  chunk: WindowChunk,
  max: number = WINDOW_MAX_CHUNKS,
): TrimInstruction | null {
  window.push(chunk);
  if (window.length <= max) return null;
  const removed = window.shift()!;
  return { trimChars: removed.chars, trimBytes: removed.bytes };
}

/** Add a chunk at the start; over budget, the last chunk must be trimmed. */
export function pushFront(
  window: WindowChunk[],
  chunk: WindowChunk,
  max: number = WINDOW_MAX_CHUNKS,
): TrimInstruction | null {
  window.unshift(chunk);
  if (window.length <= max) return null;
  const removed = window.pop()!;
  return { trimChars: removed.chars, trimBytes: removed.bytes };
}
