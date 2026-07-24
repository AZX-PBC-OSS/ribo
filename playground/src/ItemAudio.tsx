import { useEffect, useState } from "react";
import type { Outbox } from "@azx/ribo-core";

import { formatBytes, messageOf } from "./format.js";
import { muted } from "./styles.js";

/**
 * @file Playback for one queued item — the part of the reload check that a row
 * in a table cannot do.
 *
 * A row surviving a reload only proves the *document* persisted. The audio is
 * an RxDB **attachment**, stored and evicted separately, so "the recording
 * survived" is a claim only an ear can settle. Hence a real `<audio controls>`
 * per item rather than a byte count.
 *
 * There is no retry loop here, and there must not be one. `hasAudio` on the
 * item is authoritative at the moment it is emitted: `Outbox.enqueue` writes
 * the document and its attachment in a single storage transaction, so `items$`
 * cannot publish an item whose bytes have not landed. `hasAudio: false` means
 * the audio is genuinely gone — dropped after transcription, or evicted by iOS
 * — and polling for it would only delay an honest answer. This component used
 * to poll six times at 250ms because the queue could not tell the two apart.
 */

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; url: string; size: number };

export function ItemAudio({
  outbox,
  id,
  hasAudio,
  audioBytes,
  mimeType,
}: {
  outbox: Outbox;
  id: string;
  hasAudio: boolean;
  audioBytes: number;
  mimeType: string;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    // Tracked outside React state so the cleanup can revoke the URL without
    // reading it through a stale render closure.
    let objectUrl: string | undefined;
    let cancelled = false;

    if (!hasAudio) {
      setLoad({ kind: "missing" });
      return;
    }

    setLoad({ kind: "loading" });

    void (async () => {
      try {
        const blob = await outbox.getAudio(id);
        if (cancelled) return;
        // `hasAudio` was true when this item was emitted; a `false` here means
        // the bytes were dropped between that emission and this read, and the
        // next emission will say so. Reporting it as missing is the honest
        // answer either way.
        if (!blob) {
          setLoad({ kind: "missing" });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setLoad({ kind: "ready", size: blob.size, url: objectUrl });
      } catch (cause) {
        if (!cancelled) setLoad({ kind: "error", message: messageOf(cause) });
      }
    })();

    return () => {
      cancelled = true;
      // Object URLs live as long as the document otherwise, and each one pins a
      // whole recording in memory.
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [outbox, id, hasAudio]);

  if (load.kind === "loading") return <span style={muted}>loading audio…</span>;
  if (load.kind === "missing")
    return <span style={muted}>no audio attachment — the bytes were dropped</span>;
  if (load.kind === "error") return <span style={muted}>audio failed to load: {load.message}</span>;

  return (
    <div>
      <audio controls src={load.url} style={{ height: 34, verticalAlign: "middle", width: "100%" }}>
        <track kind="captions" />
      </audio>
      <div style={muted}>
        {/* `audioBytes` comes off the attachment stub, with no bytes read; the
            loaded blob's own size is the same number, and disagreeing would be
            a bug worth seeing. */}
        {formatBytes(load.size)} · {mimeType}
        {load.size !== audioBytes && ` · reported ${formatBytes(audioBytes)}`}
      </div>
    </div>
  );
}
