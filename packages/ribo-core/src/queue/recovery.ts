import type { Outbox } from "./outbox.js";
import { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";

export interface RecoveryOptions {
  outbox: Outbox;
  /**
   * Decode-verify the merged blob: returns `durationMs`, or throws if undecodable.
   * Injected so tests can fake it.
   */
  decode: (blob: Blob) => Promise<number>;
  /** Called with the ids of the new rows recovery created, so the caller can `syncNow()`. */
  onRecovered?: (ids: string[]) => void;
}

/**
 * Recover interrupted recordings at startup.
 *
 * For each row in `recording` (nothing else holds `CAPTURE_LOCK`, so none is
 * live):
 *
 * - If its chunks merge and decode → insert a NEW row, `queued`, with that
 *   audio, carrying the original's `recording` metadata and a fresh id. Then
 *   mark the original `dead` with a reason naming its successor.
 * - If its chunks cannot be decoded even after dropping the last one → leave it
 *   `dead` with `lastError` set and its chunks intact. Never write audio that
 *   does not decode; never silently discard bytes.
 *
 * There is no half-recovered state: recovery either produces a complete row or
 * produces nothing and says so.
 */
export async function recoverInterrupted(options: RecoveryOptions): Promise<string[]> {
  const { outbox, decode } = options;

  // A FAST PATH, not the safety check. `holdLock` below already refuses when the lock is
  // held — it requests with `ifAvailable`, so a live session makes it return `undefined`
  // and this function resolves `[]` either way. Verified by mutation: deleting this line
  // changes no test. It stays only to skip a pointless `outbox.list` on the common path
  // where someone is recording.
  //
  // Do not read it as the thing that stops recovery stealing a live recording. That is
  // `holdLock`, and removing THAT would be silent.
  if (!(await isLockFree(CAPTURE_LOCK))) return [];

  const recording = await outbox.list({ status: ["recording"] });
  if (recording.length === 0) return [];

  // Take the lock for the duration of recovery, so a second tab does not race.
  // The `isLockFree` check above is advisory — a live session could have started
  // between it and here. `holdLock` returns `undefined` if the lock was taken in
  // that window, and in that case the live session owns the rows, so we resolve
  // empty rather than recovering under it.
  // Await the callback's OWN promise rather than resolving an outer one from inside it.
  // The earlier shape resolved only on the success path, so a throw anywhere in
  // `recoverOne`, `patch` or `onRecovered` released the lock and left this promise pending
  // forever — the caller hung with no error, which at startup means the app never finishes
  // starting.
  const held = await holdLock(CAPTURE_LOCK, async () => {
    const recoveredIds: string[] = [];
    for (const item of recording) {
      const id = await recoverOne(outbox, item.id, decode);
      if (id) recoveredIds.push(id);
    }
    options.onRecovered?.(recoveredIds);
    return recoveredIds;
  });
  // Taken between the advisory check and here: the live session owns those rows.
  if (held === undefined) return [];
  return await held.ready;
}

/**
 * Recover one interrupted row. Returns the id of the new row, or `undefined` if
 * the row was marked dead without recovery.
 *
 * Tries the full merged blob first. On decode failure, retries without the last
 * chunk — a truncated tail is the one case where dropping bytes can turn an
 * undecodable merge into a decodable one. Tracks which blob actually decoded so
 * the new row carries the right audio.
 */
async function recoverOne(
  outbox: Outbox,
  id: string,
  decode: (blob: Blob) => Promise<number>,
): Promise<string | undefined> {
  const item = await outbox.get(id);
  if (!item || item.status !== "recording") return undefined;

  const sourceId = item.capture?.sourceId;
  if (!sourceId) {
    await outbox.patch(id, { status: "dead", lastError: "unrecoverable: no capture.sourceId" });
    return undefined;
  }

  // Try to merge and decode. On failure, retry without the last chunk.
  const merged = await outbox.mergeChunks(id);
  let audio: Blob;
  let durationMs: number;
  try {
    durationMs = await decode(merged);
    audio = merged;
  } catch {
    // Drop the last chunk and retry — a truncated tail may be the culprit.
    const trimmed = await outbox.mergeChunksExcludingLast(id);
    if (trimmed === null) {
      // Only one chunk and it failed — nothing to drop.
      await outbox.patch(id, { status: "dead", lastError: "unrecoverable: cannot decode audio" });
      return undefined;
    }
    try {
      durationMs = await decode(trimmed);
      audio = trimmed;
    } catch {
      // Still undecodable — leave dead with chunks intact.
      await outbox.patch(id, { status: "dead", lastError: "unrecoverable: cannot decode audio" });
      return undefined;
    }
  }

  // Success: insert a NEW row, queued, with the recovered audio. The new row
  // goes through the ordinary pipeline — created the way every other row is
  // created, with no `capture` and a fresh id. There is no half-recovered state.
  const newItem = await outbox.enqueue({
    recording: { ...item.recording, durationMs },
    audio,
  });

  // Mark the original dead with a reason naming its successor. The new row
  // exists before the original is marked, so the `lastError` can name it —
  // an operator seeing the orphan knows exactly where the audio went.
  await outbox.patch(id, {
    status: "dead",
    lastError: `recovered as ${newItem.id}`,
  });

  return newItem.id;
}
