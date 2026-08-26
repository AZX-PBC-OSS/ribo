import type { CSSProperties } from "react";

/**
 * @file The whole stylesheet, as plain objects.
 *
 * This is a harness, not a product: no CSS framework, no component library, no
 * design system. Enough styling that the state of the recorder is obvious at a
 * glance, and no more.
 */

export const page: CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.5,
  margin: "0 auto",
  maxWidth: 780,
  padding: "1.5rem 1rem 3rem",
};

export const panel: CSSProperties = {
  border: "1px solid #d0d7de",
  borderRadius: 8,
  marginBottom: "1.5rem",
  padding: "1rem 1.25rem",
};

export const muted: CSSProperties = { color: "#57606a", fontSize: "0.85rem" };

export const monospace: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const errorBox: CSSProperties = {
  background: "#fff5f5",
  border: "1px solid #d1242f",
  borderRadius: 6,
  color: "#d1242f",
  marginTop: "0.75rem",
  padding: "0.5rem 0.75rem",
};

/**
 * For things that are expected but need saying — storage eviction, most of all.
 *
 * Deliberately not `errorBox`. `docs/implementation/09-offline-first.md` treats
 * the iOS 7-day wipe as a design constraint rather than a fault, and red is the
 * colour of "something went wrong"; painting the expected path red teaches
 * people to distrust an app that is working exactly as designed.
 */
export const noticeBox: CSSProperties = {
  background: "#fff8c5",
  border: "1px solid #d4a72c",
  borderRadius: 6,
  color: "#4d2d00",
  marginTop: "0.75rem",
  padding: "0.75rem 0.9rem",
};

export const button: CSSProperties = {
  border: "1px solid #d0d7de",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  padding: "0.4rem 0.8rem",
};

/** The record button is the one control that must read from across the room. */
export function recordButton(recording: boolean): CSSProperties {
  return {
    ...button,
    background: recording ? "#d1242f" : "#1f883d",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: "1.05rem",
    fontWeight: 600,
    minWidth: 190,
    padding: "0.7rem 1.2rem",
  };
}

const STATUS_COLORS: Record<string, string> = {
  // Not the fallback grey, which reads as inert for the one status that is
  // actively changing, and not red, which is two shades from `dead` on this
  // page. Orange says "live, and this tab matters" without claiming a fault.
  recording: "#bc4c00",
  queued: "#0969da",
  transcribing: "#8250df",
  extracting: "#8250df",
  writing: "#8250df",
  done: "#1f883d",
  failed: "#bf8700",
  dead: "#d1242f",
};

export function statusBadge(status: string): CSSProperties {
  return {
    background: STATUS_COLORS[status] ?? "#57606a",
    borderRadius: 999,
    color: "#fff",
    display: "inline-block",
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    padding: "0.1rem 0.55rem",
    textTransform: "uppercase",
  };
}

export const survivedBadge: CSSProperties = {
  border: "1px solid #1f883d",
  borderRadius: 999,
  color: "#1f883d",
  fontSize: "0.75rem",
  fontWeight: 600,
  padding: "0.1rem 0.55rem",
};

/** Badges a review card that was drafted by the on-device beta model. */
export const betaBadge: CSSProperties = {
  background: "#bf8700",
  borderRadius: 999,
  color: "#fff",
  fontSize: "0.75rem",
  fontWeight: 600,
  padding: "0.1rem 0.55rem",
  textTransform: "uppercase",
};
