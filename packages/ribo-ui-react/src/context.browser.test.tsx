import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { Recorder } from "@azx/ribo-core";

import { RiboProvider } from "./RiboProvider.js";
import { useRiboInstance } from "./use-ribo-instance.js";

// vitest-browser-react@2.2.0's `render` is async (it awaits React's commit
// before returning), unlike the brief's synchronous sample — see
// workspace-resolution.browser.test.tsx. That also means a component that
// throws during render surfaces as a *rejected* `render()` promise rather than
// a synchronous throw, so the "missing instance" tests below assert on
// `.rejects.toThrow(...)` instead of wrapping the call in `() => …`.

function ShowsPhase() {
  const recorder = useRiboInstance("recorder");
  return <p>{recorder.phase}</p>;
}

test("a hook resolves its instance from the provider", async () => {
  const recorder = new Recorder();
  const screen = await render(
    <RiboProvider value={{ recorder }}>
      <ShowsPhase />
    </RiboProvider>,
  );
  expect(screen.getByText("idle")).toBeInTheDocument();
});

test("an override wins over the provider, which is how tests inject", async () => {
  const provided = new Recorder();
  const override = new Recorder();
  let seen: unknown;
  function Probe() {
    seen = useRiboInstance("recorder", override);
    return null;
  }
  await render(
    <RiboProvider value={{ recorder: provided }}>
      <Probe />
    </RiboProvider>,
  );
  expect(seen).toBe(override);
});

test("a missing instance throws a message naming what to supply", async () => {
  // The failure mode this replaces is an `undefined` read three frames later, in
  // a component that did not cause it.
  await expect(render(<ShowsPhase />)).rejects.toThrow(/recorder/i);
  await expect(render(<ShowsPhase />)).rejects.toThrow(/RiboProvider/);
});

test("an instance absent from a provider that has others still throws", async () => {
  function NeedsOutbox() {
    useRiboInstance("outbox");
    return null;
  }
  await expect(
    render(
      <RiboProvider value={{ recorder: new Recorder() }}>
        <NeedsOutbox />
      </RiboProvider>,
    ),
  ).rejects.toThrow(/outbox/i);
});
