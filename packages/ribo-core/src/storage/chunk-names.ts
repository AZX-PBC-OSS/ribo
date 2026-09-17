/**
 * @file Attachment names for durable capture, and the slicing of oversized events.
 *
 * Chunks are named from the recording's IMMUTABLE `capture.sourceId`. Recovery
 * must find every chunk of a recording, and `sourceId` never changes — so naming
 * by `sourceId` means recovery always finds them.
 */

export const MAX_CHUNK_INDEX = 999_999;
export const MAX_SLICE_INDEX = 99;

export const chunkPrefix = (sourceId: string): string => `audio-${sourceId}-`;

export function chunkName(sourceId: string, chunkIndex: number, sliceIndex: number): string {
  if (chunkIndex > MAX_CHUNK_INDEX)
    throw new Error(
      `chunk index overflow at ${chunkIndex}: capture must stop before names mis-sort`,
    );
  if (sliceIndex > MAX_SLICE_INDEX)
    throw new Error(
      `slice index overflow at ${sliceIndex}: capture must stop before names mis-sort`,
    );
  return `${chunkPrefix(sourceId)}${String(chunkIndex).padStart(6, "0")}-${String(sliceIndex).padStart(2, "0")}`;
}

export const isChunkOf = (id: string, sourceId: string): boolean =>
  id.startsWith(chunkPrefix(sourceId));

/**
 * Split a blob larger than `max` into ordered parts.
 *
 * A timeslice does not bound chunk size: a Chrome desktop sleep/wake has been
 * measured producing 23 MB in one event. Byte-slicing is safe — concatenating
 * the parts in order reproduces the original exactly — but each slice must carry
 * the negotiated MIME type explicitly, because `Blob.slice()` returns an empty
 * `type` and RxDB rejects an empty attachment content type.
 */
export function sliceOversized(blob: Blob, mimeType: string, max: number): Blob[] {
  if (blob.size <= max) return [blob.type ? blob : blob.slice(0, blob.size, mimeType)];
  const parts: Blob[] = [];
  for (let offset = 0; offset < blob.size; offset += max) {
    parts.push(blob.slice(offset, Math.min(offset + max, blob.size), mimeType));
  }
  return parts;
}
