import { formatClock } from "./format.js";
import { monospace, muted, panel } from "./styles.js";
import { PAGE_LOADED_AT } from "./session.js";

/**
 * @file Phase 2's definition of done, written where the person checking it is
 * already looking.
 *
 * The outbox is the one subsystem where "it works" and "it looks like it works"
 * are indistinguishable without a refresh — a row appears either way. So the
 * recipe lives in the UI, not in a doc nobody opens.
 */

const STEPS = [
  "Press ● Start recording and say something for a few seconds. The timer runs and the level meter moves — that is a live microphone, not a spinner.",
  "Press ■ Stop and queue. A row appears in the outbox below within a moment, status queued.",
  "Play that row's audio. You should hear yourself. A row proves a document persisted; playback proves the attachment did.",
  "Reload the page (⌘R / F5). This is the step that matters — everything above is still just memory.",
  "The row is still there, still queued, now marked “survived reload ✓”, and still plays. That is Phase 2 done.",
  "Phase 2.5, and only in a production build (pnpm build && pnpm --filter playground preview — the service worker is off in dev): wait for “Ready to work offline ✓” above, then turn the network off entirely and reload. The page still loads, and the queue is still there. Gated by playground/e2e/offline-boot.e2e.test.ts, which does exactly this in CI.",
  "Read “Storage durability” above and believe it literally. “NOT persistent” means the browser refused to protect this data and can delete it — that is the normal answer in an iOS Safari tab, and the Add-to-Home-Screen prompt right below it is the fix rather than an advert.",
  "Eviction, by hand: with something queued, open devtools → Application → Storage and delete IndexedDB and Cache Storage (leave cookies and Local Storage alone — a real eviction takes the first two). Reload. Instead of an empty list you get “Your queued recordings were removed by the browser to free space”. Gated by playground/e2e/eviction.e2e.test.ts.",
];

export function VerifyPanel() {
  return (
    <section style={{ ...panel, background: "#f6f8fa" }}>
      <h2>Verify it works — about fifteen seconds</h2>
      <ol style={{ margin: "0.5rem 0", paddingLeft: "1.4rem" }}>
        {STEPS.map((step) => (
          <li key={step} style={{ marginBottom: "0.35rem" }}>
            {step}
          </li>
        ))}
      </ol>
      <p style={muted}>
        This page loaded at <span style={monospace}>{formatClock(PAGE_LOADED_AT)}</span>. Anything
        queued before then is badged “survived reload”, so step 5 needs no note-taking. To start
        over, use <em>clear queue</em>.
      </p>
    </section>
  );
}
