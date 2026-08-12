import { useEffect, useState } from "react";

import { messageOf } from "./format.js";
import { getRecovery } from "./recovery-handle.js";
import { errorBox, monospace, muted, noticeBox } from "./styles.js";

/**
 * @file What the user is told when a recording that was interrupted came back.
 *
 * The counterpart to `EvictionNotice`, and deliberately the opposite tone. That
 * one reports work that is gone; this one reports work that survived something
 * which used to destroy it — a crash, a tab close, a battery death mid-sentence.
 *
 * It only renders when recovery actually produced something. A banner saying
 * "nothing to recover" on every load would train people to stop reading it, and
 * the honest silent case is by far the common one.
 *
 * The copy names the orphan on purpose. Recovery leaves the interrupted row
 * behind at `dead`, carrying `recovered as <id>` — so someone reading the queue
 * below sees a red row seconds after being told everything was fine, and needs
 * to know that row is the receipt rather than a second failure.
 */

type State =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "done"; ids: readonly string[] };

export function RecoveryNotice() {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    void getRecovery()
      .then((ids) => {
        if (!cancelled) setState({ kind: "done", ids });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ kind: "error", message: messageOf(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recovery failing is worth saying out loud: it means chunks are on disk that
  // nothing will pick up on its own, which is exactly the state this feature
  // exists to end.
  if (state.kind === "error") {
    return (
      <section style={errorBox}>
        <p style={{ margin: 0 }}>Startup recovery failed: {state.message}</p>
      </section>
    );
  }

  if (state.kind !== "done" || state.ids.length === 0) return null;

  const count = state.ids.length;
  const plural = count === 1 ? "recording" : "recordings";

  return (
    <section data-testid="recovery-notice" style={noticeBox}>
      <p style={{ fontWeight: 600, margin: 0 }}>
        {count} interrupted {plural} {count === 1 ? "was" : "were"} recovered and queued.
      </p>
      <p style={{ margin: "0.5rem 0 0" }}>
        The audio was written to disk as it was captured, so the part recorded before the
        interruption survived it. Only the final moments are missing — whatever had not been flushed
        yet, plus however long the app was closed.
      </p>
      <p style={{ ...muted, margin: "0.6rem 0 0" }}>
        Recovery inserts a <em>new</em> row and never edits the interrupted one, so the original is
        still in the queue below marked <code style={monospace}>dead</code> with{" "}
        <code style={monospace}>recovered as …</code>. That row is the audit trail, not a second
        failure.
      </p>
    </section>
  );
}
