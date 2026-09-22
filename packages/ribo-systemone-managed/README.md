# @azx/ribo-systemone-managed

A client for the System One HTTP API: POST a text and a set of typed yes/no questions, get back
calibrated probabilities (noul values) for each. The client is a plain seam for detectors in a
Ribo arbitration ladder — it classifies failures as terminal or transient so a ladder can fall
through or give up correctly, and it owns no retry policy of its own.

## One API, three deployments

Hosted TypeSafe ("Jev"), a self-hosted `kev` server, and a fine-tune all implement the same
endpoint contract, so this one client serves all three. That is why the package is named for the
deployment mode (`managed`) and not for a vendor: swapping a hosted model for a self-hosted one is
a change of `endpoint`, nothing else.

## No capacity to authenticate

The package never reads an environment variable, never holds a secret, and never sets an
`Authorization` header. It takes the endpoint and an injected `fetch` — the host's transport
attaches whatever credential the call needs, exactly like
[`@azx/ribo-transcriber-managed`](../ribo-transcriber-managed/README.md). There is no `apiKey`
option to misconfigure.

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

const verdicts = await client.ask("The attic has R-19 fiberglass batts.", {
  insulated: {
    instructions: "Does the text state the attic is insulated?",
    criteria: { true: "states insulation is present", false: "states it is absent" },
  },
});
// { insulated: 0.97 }
```

## Learn more

- [Repo root](../../README.md)
