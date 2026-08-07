import type { CSSProperties } from "react";
import type { ConnectivityStatus } from "@azx/ribo-core";
import { useConnectivity } from "@azx/ribo-ui-react";

import { monospace, muted, panel } from "./styles.js";

/**
 * @file Connectivity, shown as the three states it actually has.
 *
 * The point of this panel is to *not* collapse to a boolean. `navigator.onLine`
 * lies (a captive portal or a tower with no backhaul both report `true`), so this
 * shows what the reachability probe found, and — crucially — shows `probing` as a
 * first-class state rather than a glitch: it is the hysteresis window, the "still
 * checking" gap where the link claims online but reachability is not yet
 * confirmed (or is being held across the stability window before `online` is
 * asserted). `online` here means a probe succeeded *and stayed healthy*, not that
 * the browser felt optimistic.
 *
 * This panel only *displays*. It never drains the queue — see `QueuePanel`'s
 * opt-in "auto-sync when online" toggle for the one place connectivity is allowed
 * to drive work.
 *
 * `useConnectivity()` resolves the shared `Connectivity` model through
 * `RiboProvider` (wired in `App.tsx` from `connectivity-store.ts`), so this panel
 * no longer needs its own `useSyncExternalStore` plumbing.
 */

export function ConnectivityPanel() {
  const { status } = useConnectivity();

  return (
    <section style={{ ...panel, background: "#f6f8fa" }}>
      <h2 style={{ fontSize: "1rem", margin: 0 }}>Connectivity</h2>

      <p style={{ margin: "0.5rem 0 0" }} data-testid="connectivity-status">
        <span style={dot(status)} aria-hidden="true" />
        <strong>{headline(status)}</strong>
      </p>

      <p style={{ ...muted, margin: "0.35rem 0 0" }}>{detail(status)}</p>

      <p style={{ ...muted, margin: "0.5rem 0 0" }}>
        <strong>Why three states.</strong> <code style={monospace}>online</code> is asserted only
        after a probe stays healthy across a short stability window, so a marginal signal flapping
        back for a second does not count. The probe checks that the network is actually{" "}
        <em>reachable</em> rather than trusting <code style={monospace}>navigator.onLine</code>,
        which reports the link layer and can say “online” with no route out.
      </p>

      <p style={{ ...muted, margin: "0.5rem 0 0" }}>
        <strong>Exercise it.</strong> Toggle <em>Offline</em> in DevTools (Network tab, or the
        Command Menu) and this drops to <code style={monospace}>offline</code> at once; clear it and
        it passes back through <code style={monospace}>probing</code> before it will claim{" "}
        <code style={monospace}>online</code>.
      </p>
    </section>
  );
}

const STATUS_COLOR: Record<ConnectivityStatus, string> = {
  offline: "#d1242f",
  probing: "#bf8700",
  online: "#1f883d",
};

function dot(status: ConnectivityStatus): CSSProperties {
  return {
    background: STATUS_COLOR[status],
    borderRadius: 999,
    display: "inline-block",
    height: "0.6rem",
    marginRight: "0.5rem",
    verticalAlign: "middle",
    width: "0.6rem",
  };
}

function headline(status: ConnectivityStatus): string {
  switch (status) {
    case "offline":
      return "Offline — unreachable.";
    case "probing":
      return "Probing — checking whether the network is really reachable…";
    case "online":
      return "Online — reachability confirmed.";
  }
}

function detail(status: ConnectivityStatus): string {
  switch (status) {
    case "offline":
      return "The link is down, or a probe failed. Offline is trusted instantly — a lost connection is never worth delaying.";
    case "probing":
      return "The link says it is up, but that has not been confirmed yet, or a healthy probe is being held across the stability window before online is asserted. This is the hysteresis, made visible — not a glitch.";
    case "online":
      return "A reachability probe succeeded and stayed healthy across the stability window. This is the only state the queue relay would drain on.";
  }
}
