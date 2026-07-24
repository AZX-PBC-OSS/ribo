/**
 * @file Display helpers. No behavior worth testing lives here.
 */

/** `m:ss.t` — tenths, because the elapsed readout updates ten times a second. */
export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}.${String(tenths)}`;
}

/** Wall-clock time of an ISO timestamp, in the viewer's locale. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  // The GB tier exists for storage quota, not for audio: Chromium hands back
  // ten-figure quotas, and "10240.00 MB" is a number a person has to stop and
  // divide. Recording sizes never reach it.
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The message of anything that was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
