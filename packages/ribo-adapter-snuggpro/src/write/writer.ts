/**
 * @file The Snugg Pro HTTP writer: one group's reviewed patch becomes one
 * vendor request, whose response is parsed for the record's identifier and
 * whose failures are classified for the relay.
 *
 * I/O, URL building and classification only — the patch→wire-body transform is
 * `buildWriteBody`'s, and nothing here duplicates it. The package holds no
 * credential and gains no capacity to authenticate: the host's `fetchImpl`
 * routes through its gateway, which signs the request and injects the stored
 * credential (the `ribo-transcriber-managed` precedent).
 */

import { ReceiptedWriteError, TerminalError, type WriteMetadata } from "@azx/ribo-core";
import type { SnuggWriteContext } from "../context.js";
import { SNUGG_ENDPOINTS } from "../endpoints.generated.js";
import type {
  SnuggEndpointKind,
  SnuggEndpointOperation,
  SnuggGroupEndpoints,
} from "../endpoints.generated.js";
import { buildWriteBody, type SnuggWriteOperationName } from "./body.js";
import { helixErrorEnvelopeSchema, snuggRecordSchema } from "./response.js";

/**
 * Options for the Snugg Pro HTTP writer.
 *
 * @category Tool Adapters
 */
export interface SnuggHttpWriterOptions {
  /**
   * Override `fetch` — inject a double for tests, or the host's
   * credential-attaching transport for production. Defaults to the bare global
   * `fetch`, which is expressly allowed in this headless package (AGENTS §4).
   *
   * The base URL is NOT an option: `snuggCtxSchema.apiBaseUrl` is the one
   * source for it, validated and persisted with the session.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Writes one group's reviewed patch to Snugg Pro and resolves with the record's
 * identifier — the write receipt `toInstanceWriteStep` records and a retry
 * hands back as `meta.linkTarget`.
 * @category Tool Adapters
 */
export type SnuggHttpWriter = (
  group: string,
  values: Record<string, unknown>,
  ctx: SnuggWriteContext,
  meta: WriteMetadata,
) => Promise<{ readonly receipt: string }>;

/**
 * An HTTP failure the relay's backoff owns: 408, 429 or a 5xx. Carries
 * `status`, which `isTransientFailure` reads, so the item stays retryable
 * instead of landing `dead`.
 */
class TransientStatusError extends Error {
  override readonly name: string = "TransientStatusError";

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The operation one write uses, from the endpoint table's `kind`. For a
 * collection the branch runs on `meta.linkTarget`'s presence alone, because
 * `toInstanceWriteStep` has already resolved it — a human's link decision, else
 * the receipt an earlier attempt recorded — and handing the writer one resolved
 * target is the whole point. A singleton's single POST serves both create and
 * update, and the job IS the assessment the ctx addresses: neither branches.
 */
const selectOperation = (
  group: string,
  endpoints: SnuggGroupEndpoints,
  linkTarget: string | undefined,
): {
  readonly name: SnuggWriteOperationName;
  readonly kind: SnuggEndpointKind;
  readonly operation: SnuggEndpointOperation;
} => {
  if (endpoints.kind === "singleton") {
    if (!endpoints.upsert) {
      throw new Error(`write/writer: the "${group}" group has no "upsert" operation.`);
    }
    return { name: "upsert", kind: endpoints.kind, operation: endpoints.upsert };
  }
  if (endpoints.kind === "job" || linkTarget !== undefined) {
    if (!endpoints.update) {
      throw new Error(`write/writer: the "${group}" group has no "update" operation.`);
    }
    return { name: "update", kind: endpoints.kind, operation: endpoints.update };
  }
  if (!endpoints.create) {
    throw new Error(`write/writer: the "${group}" group has no "create" operation.`);
  }
  return { name: "create", kind: endpoints.kind, operation: endpoints.create };
};

/**
 * Interpolate the template's `{jobId}` and `{uuid}` placeholders and join it to
 * the context's base URL. `{jobId}` is the assessment the ctx addresses;
 * `{uuid}` is the resolved link target, path-segment-encoded because a receipt
 * comes back out of a persisted row. The join is string concatenation, not
 * `new URL(path, base)` — which would drop a base path like `…/gateway/snugg`.
 */
const buildRequestUrl = (
  ctx: SnuggWriteContext,
  path: string,
  linkTarget: string | undefined,
): string => {
  let interpolated = path.replaceAll("{jobId}", ctx.assessmentId);
  if (interpolated.includes("{uuid}")) {
    if (linkTarget === undefined) {
      throw new Error(
        `write/writer: the path template "${path}" carries {uuid}, but this write carries no linkTarget.`,
      );
    }
    interpolated = interpolated.replaceAll("{uuid}", encodeURIComponent(linkTarget));
  }
  return new URL(`${ctx.apiBaseUrl.replace(/\/+$/, "")}${interpolated}`).href;
};

/**
 * Throw the error one non-2xx response becomes. Row order matters: the 401
 * split reads the body and the 404 split reads the operation, and both must
 * fire before the generic transient and terminal rows.
 */
const throwClassifiedFailure = async (
  response: Response,
  group: string,
  operationName: SnuggWriteOperationName,
  meta: WriteMetadata,
  ctx: SnuggWriteContext,
): Promise<never> => {
  const bodyText = await response.text();
  const status = response.status;

  if (status === 401) {
    // The split is by body SHAPE, not status — the two causes have opposite
    // remedies, and confusing them sends an auditor round a loop that cannot
    // succeed. Helix denies in its own envelope; the vendor's refusal is
    // relayed with the vendor's — empty — body.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // A non-JSON body is the vendor's, not the platform's.
    }
    if (helixErrorEnvelopeSchema.safeParse(parsed).success) {
      throw new Error(
        `write/writer: the Helix platform session lapsed (401 from the gateway). Reload the ` +
          `app to re-establish it; the relay will retry the write.`,
      );
    }
    throw new TerminalError(
      `write/writer: Snugg Pro rejected the write's credential (401 without the Helix error ` +
        `envelope). The credential is injected by the host's transport, so this is a ` +
        `configuration fault that neither a retry nor a reload fixes — check the credential ` +
        `the Helix egress layer holds for Snugg Pro.`,
    );
  }

  if (status === 404 && operationName === "update") {
    // The record was deleted in Snugg Pro's web UI between attempts, so the
    // stored receipt (or a human's link decision) is stale. A retry cannot
    // conjure the record back; the message is the only thing that tells a
    // human what happened, so it names the target and the recovery.
    const stale = meta.linkTarget ?? `assessment ${ctx.assessmentId}`;
    throw new TerminalError(
      `write/writer: Snugg Pro has no ${group} record to update (404 for ${stale}) — it was ` +
        `deleted in Snugg Pro between attempts, so the link this write retried against is ` +
        `stale. Recovery: re-park the session with Storage.sessions.reopenForReview(id), ` +
        `link the instance to another existing record, or clear the link to create afresh.`,
    );
  }

  if (status === 408 || status === 429 || status >= 500) {
    throw new TransientStatusError(
      status,
      `write/writer: the Snugg Pro write failed with HTTP ${status} — transient; the relay's ` +
        `backoff owns the retry.`,
    );
  }

  throw new TerminalError(
    `write/writer: Snugg Pro rejected the write with HTTP ${status} (group "${group}"). The ` +
      `request is derived from persisted values, so a retry would fail identically.`,
  );
};

/**
 * Read a 2xx response into the write's receipt. A collection write returns the
 * record; its `uuid` is the receipt. A singleton — and the job — return no
 * identifier at all (the vendor's response definitions carry no uuid or id), so
 * the receipt is fabricated below.
 *
 * **It is not a vendor identifier, and the prefix says so.** A singleton
 * endpoint is addressed by job alone, so it needs no vendor-assigned identity
 * to be corrected later; a fabricated uuid-shaped string would be a lie a
 * later reader cannot see through. On a retry the receipt comes back as
 * `meta.linkTarget`, and neither the singleton's nor the job's path carries a
 * `{uuid}` placeholder for it to land in. (The `job` group's name and kind
 * coincide, so its receipt drops the redundant middle segment.)
 */
const readReceipt = async (
  response: Response,
  group: string,
  kind: SnuggEndpointKind,
  ctx: SnuggWriteContext,
): Promise<{ readonly receipt: string }> => {
  if (kind === "collection") {
    return { receipt: snuggRecordSchema.parse(await response.json()).uuid };
  }
  const receipt =
    kind === "job" ? `job:${ctx.assessmentId}` : `singleton:${group}:${ctx.assessmentId}`;
  return { receipt };
};

/**
 * Leaves `createHvac` discards and re-derives from the equipment type, while
 * `updateHvac` stores them as sent (measured on staging, job 588613,
 * 2026-09-30). A create that carries one is followed by an update of the new
 * record that carries just these, so the auditor's stated unit survives.
 */
const DERIVED_ON_CREATE: Readonly<Record<string, readonly string[]>> = {
  hvac: ["hvacHeatingSystemEfficiencyRatingUnit", "hvacCoolingSystemEfficiencyRatingUnit"],
};

/**
 * The follow-up's values: the discarded leaves the patch states. An explicit
 * `null` is not followed up — on a new record there is nothing to clear, and the
 * vendor's derived unit is a better value than an empty one.
 */
const followUpValues = (
  group: string,
  values: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const stated: Record<string, unknown> = {};
  for (const name of DERIVED_ON_CREATE[group] ?? []) {
    const value = values[name];
    if (value !== undefined && value !== null) stated[name] = value;
  }
  return Object.keys(stated).length > 0 ? stated : undefined;
};

/** @category Tool Adapters */
export const createSnuggHttpWriter = (options: SnuggHttpWriterOptions = {}): SnuggHttpWriter => {
  const doFetch = options.fetchImpl ?? fetch;

  const send = async (
    group: string,
    name: SnuggWriteOperationName,
    operation: SnuggEndpointOperation,
    values: Record<string, unknown>,
    ctx: SnuggWriteContext,
    meta: WriteMetadata,
  ): Promise<Response> => {
    const url = buildRequestUrl(ctx, operation.path, meta.linkTarget);
    const body = buildWriteBody(group, name, values);
    const response = await doFetch(url, {
      method: operation.verb,
      headers: {
        "content-type": "application/json",
        // Sent though the vendor ignores it (measured on staging — see
        // `WriteMetadata`): duplicate protection is the receipt a retry
        // UPDATEs, never this key.
        "Idempotency-Key": meta.idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await throwClassifiedFailure(response, group, name, meta, ctx);
    }
    return response;
  };

  return async (group, values, ctx, meta) => {
    const endpoints = SNUGG_ENDPOINTS[group];
    if (!endpoints) {
      throw new Error(`write/writer: no Snugg Pro endpoint table entry for group "${group}".`);
    }
    const { name, kind, operation } = selectOperation(group, endpoints, meta.linkTarget);
    const response = await send(group, name, operation, values, ctx, meta);
    const written = await readReceipt(response, group, kind, ctx);

    const followUp = name === "create" ? followUpValues(group, values) : undefined;
    if (followUp === undefined) return written;

    // The record now exists and its receipt is not yet returned, so anything
    // thrown from here must carry the receipt out (`ReceiptedWriteError`):
    // without it the retry creates a second record on a customer's job.
    try {
      const update = endpoints.update;
      if (!update) {
        throw new Error(`write/writer: the "${group}" group has no "update" operation.`);
      }
      await send(group, "update", update, followUp, ctx, { ...meta, linkTarget: written.receipt });
    } catch (error) {
      if (error instanceof TerminalError) {
        // The record exists without the stated units and a retry cannot fix what
        // the vendor refuses, so the item goes dead, loudly, with the receipt kept.
        throw new ReceiptedWriteError(
          written.receipt,
          new TerminalError(
            `write/writer: the ${group} record ${written.receipt} was created, but the follow-up ` +
              `update that stores its rating unit failed, so it exists WITHOUT the unit you ` +
              `stated (Snugg Pro derives one from the equipment type on create). ${error.message} ` +
              `Fix the unit in Snugg Pro, or re-park with Storage.sessions.reopenForReview(id) ` +
              `to update this same record.`,
            { cause: error },
          ),
        );
      }
      throw new ReceiptedWriteError(written.receipt, error);
    }
    return written;
  };
};
