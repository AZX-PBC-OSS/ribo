# @azx/ribo-systemone-managed

A client for the System One API: POST a state text and a set of typed questions, get back
calibrated answers — noul probabilities for yes/no questions, labelled choices with confidences
for choice questions. The wire handling is the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk);
this package classifies its typed errors as terminal or transient so a Ribo arbitration ladder can
fall through or give up correctly, and it owns no retry policy of its own.

## One API, three deployments

Hosted TypeSafe ("Jev"), a self-hosted `kev` server, and a fine-tune all implement the same
endpoint contract, so this one client serves all three. That is why the package is named for the
deployment mode (`managed`) and not for a vendor: swapping a hosted model for a self-hosted one is
a change of `endpoint`, nothing else. The `endpoint` is the API root — the SDK appends
`/v1/systemone` to it.

## No capacity to authenticate

The package never reads an environment variable, never holds a secret, and has no `apiKey` option
to misconfigure. The SDK requires an `apiKey` (and would fall back to `TYPESAFE_API_KEY` without
one), so a documented placeholder string is passed in its place — the only credential-shaped thing
on the wire is `Authorization: Bearer <placeholder>`. The real credential is the host transport's
business, exactly like [`@azx/ribo-transcriber-managed`](../ribo-transcriber-managed/README.md):
the injected `fetch` attaches, overrides or proxies it.

## No retry of its own

The SDK's client is constructed with `maxRetries: 0`. Ribo's relay and its arbitration ladders own
retry and backoff — the SDK's default (2 retries with exponential backoff) would multiply the cost
of every failing call and delay transient errors reaching the arbiter that acts on them.

## Browser hosts must proxy

The hosted endpoint sends no CORS headers for any origin, so a browser cannot call it directly.
Point the client at the host's own proxy (the transport that already carries the credential)
instead.

## Composing it

```ts
import { systemOneClient } from "@azx/ribo-systemone-managed";

// `doFetch` is the host's transport — it carries the credential; this package never sees it.
const client = systemOneClient({
  endpoint: "https://system-one.example.internal/proxy",
  fetch: doFetch,
});

const answers = await client.ask("The attic has R-19 fiberglass batts.", {
  insulated: noul("Does the text state the attic is insulated?", {
    true: "states insulation is present",
    false: "states it is absent",
  }),
  material: choice("What is the insulation made of?", {
    fibreglass: "glass fibres",
    cellulose: "paper fibres",
  }),
});
// {
//   insulated: { type: "noul", noul: 0.97 },
//   material: { type: "choice", choice: "fibreglass", confidence: 0.8, probabilities: { … } },
// }
```

Questions beyond `batchSize` (default 30) are split across sequential requests and merged — every
id exactly once.

## Learn more

- [Repo root](../../README.md)
