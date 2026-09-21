import type { Observable } from "rxjs";
import { map } from "rxjs";

import { reviewOutcomeSchema, type PersistedReviewOutcome } from "../review/review.js";
import {
  ACTIVE_SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
  type SessionDocument,
  type SessionItem,
  type SessionPatch,
  type SessionStatus,
} from "./session-schema.js";
import type { CaptureStore } from "./captures.js";
import type { Finders, StorageBackend, StoredDocument } from "./port.js";
import type { StoreDeps } from "./deps.js";

/**
 * @file The session store: extraction, review and write-back state for a set of
 * captures taken together.
 *
 * The other half of the old `Outbox` class. A session's machine is not a
 * capture's — it owns what happens to the words after they are text, and nothing
 * here knows whether those words came from a microphone or a PDF.
 */

/** What a caller hands to open a session. */
export interface OpenSessionInput {
  /** Stable id for the session. Generated if omitted. */
  readonly id?: string;
  /** Idempotency key for the vendor write. Generated if omitted. */
  readonly idempotencyKey?: string;
  /**
   * The write destination — opaque to core in what it MEANS, but it must be an
   * object: it is stored as one, and the adapter parses it through
   * `ToolAdapter.ctxSchema` at write time. `unknown` rather than a type
   * parameter for the same reason `Recording.ctx` is: core has no business
   * knowing what a session is about.
   * Required: the session owns its destination, so the relay does not recover
   * it from a recording.
   */
  readonly ctx: unknown;
  /**
   * What the session is for — a bounded, indexed string. Required and
   * non-unique: two sessions may share one (a re-audit, a QA pass). Core never
   * parses it; the contract is that it is queryable.
   */
  readonly ref: string;
}

/**
 * Which sessions a read is interested in. Every field is optional, and the
 * empty query means "everything, `openedAt`-ascending".
 */
export interface SessionQuery {
  status?: SessionStatus | readonly SessionStatus[];
  /** Match sessions whose `ref` is exactly this string. */
  ref?: string;
  /** At most this many sessions, still lowest-`openedAt` first. */
  limit?: number;
}

/** Every operation over sessions. Reached as `storage.sessions`. */
export class SessionStore {
  readonly #backend: StorageBackend;
  readonly #captures: CaptureStore;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createIdempotencyKey: () => string;

  constructor(deps: StoreDeps, captures: CaptureStore) {
    this.#backend = deps.backend;
    this.#captures = captures;
    this.#now = deps.now;
    this.#createId = deps.createId;
    this.#createIdempotencyKey = deps.createIdempotencyKey;
  }

  /**
   * Open a session: the auditor is starting a job. The session owns extraction,
   * review and write state for a set of recordings captured together.
   *
   * The id and idempotency key are generated if not supplied. `ctx` (the write
   * destination) and `ref` (what the session is for) are required — the session
   * owns its destination and its subject, and both are decided once.
   */
  async open(options: OpenSessionInput): Promise<SessionItem> {
    // `ctx` is typed `unknown` (required), but `z.unknown()` accepts
    // `undefined` — so the schema parse alone cannot enforce presence. A
    // host that bypasses the type system would silently open a session with
    // no write destination.
    //
    // The object check is the same guard one level up. `sessionRxSchema` types
    // `ctx` as an object, so a primitive passes both the TypeScript signature
    // (`unknown`) and the zod parse, then fails deep inside RxDB's insert
    // validator where the error names a JSON-schema path rather than the
    // mistake. Refusing it here costs nothing and says what is wrong.
    if (options.ctx === undefined || typeof options.ctx !== "object" || options.ctx === null) {
      throw new Error(
        "openSession: `ctx` must be an object — the session owns its write destination, and " +
          "the adapter parses it through `ToolAdapter.ctxSchema`.",
      );
    }
    const inserted = await this.#backend.insert(
      "sessions",
      sessionDocumentSchema.parse({
        id: options.id ?? this.#createId(),
        status: "open",
        openedAt: this.#nowIso(),
        ctx: options.ctx,
        ref: options.ref,
        attempts: 0,
        nextAttemptAt: this.#nowIso(),
        idempotencyKey: options.idempotencyKey ?? this.#createIdempotencyKey(),
      } satisfies SessionDocument),
    );
    return this.#toSession(inserted);
  }

  /**
   * Close a session: the auditor is done walking the house.
   *
   * Transitions `open → extracting` so the relay picks it up on its next drain
   * and runs session-level extraction. Sets `closedAt`.
   *
   * Refuses a session that is not `open`: closing an already-closed or
   * finished session would either double-write `closedAt` or jump the state
   * machine backwards, and either is a bug the caller should hear about.
   */
  async close(id: string): Promise<SessionItem> {
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }
    const updated = await this.#modifySession(id, (current) => {
      if (current.status !== "open") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "open", so it cannot be closed.`,
        );
      }
      const merged = {
        ...current,
        status: "extracting" as const,
        closedAt: this.#nowIso(),
      };
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  /** One session by id, or `undefined` if it is not there. */
  async get(id: string): Promise<SessionItem | undefined> {
    const document = await this.#backend.get("sessions", id);
    return document ? this.#toSession(document) : undefined;
  }

  /** Every session, `openedAt`-ascending — or just the ones matching `query`. */
  async list(query: SessionQuery = {}): Promise<SessionItem[]> {
    const documents = await this.#backend.find("sessions", sessionFinder(query));
    return documents.map((document) => this.#toSession(document));
  }

  /**
   * Sessions as a live stream, `openedAt`-ascending. Same shape as
   * {@link watch} for recordings: RxDB pushes a new array on every write,
   * including writes from another tab.
   */
  watch(query: SessionQuery = {}): Observable<SessionItem[]> {
    return this.#backend
      .watch("sessions", sessionFinder(query))
      .pipe(map((documents) => documents.map((document) => this.#toSession(document))));
  }

  /**
   * The lowest-`openedAt` session the relay has not finished with — regardless
   * of whether its backoff has elapsed. Readiness is the relay's decision, not
   * storage's, for the same reason as {@link nextPending} on recordings.
   */
  async nextPending(): Promise<SessionItem | undefined> {
    const [session] = await this.list({
      status: ACTIVE_SESSION_STATUSES,
      limit: 1,
    });
    return session;
  }

  /**
   * Apply a partial update to a session. The merged document is validated
   * **before** the write, so a bad status or a malformed field fails here
   * rather than at the next reload.
   */
  async patch(id: string, patch: SessionPatch): Promise<SessionItem> {
    const existing = await this.#backend.get("sessions", id);
    if (!existing) throw new Error(`outbox: no session with id "${id}"`);
    sessionItemSchema.parse({ ...this.#toSession(existing), ...patch });
    const updated = await this.#modifySession(id, (current) => ({ ...current, ...patch }));
    return this.#toSession(updated);
  }

  /**
   * Record what a human decided about a parked session, and move it forward.
   *
   * The only way out of `awaiting-review` on a session, and it **only** works
   * from `awaiting-review`. Guarded by `incrementalModify`, which RxDB re-runs
   * against the current document on write conflict, so the status check and the
   * mutation cannot be split by a second tab or a duplicate submission — the
   * same guard shape as {@link reopenSessionForReview}'s own status check below.
   *
   * - `accepted` / `edited` → `writing`, with `attempts` reset so the write
   *   gets a clean backoff budget. The relay picks the session up on its next
   *   drain and passes `outcome.fields` to the write step.
   * - `discarded` → `done`. Unlike the recording's discard (which drops audio),
   *   there is no audio on the session to drop — the recordings stay in the
   *   storage. The session is finished; the `reviewOutcome` records why.
   */
  async submitReview(id: string, outcome: PersistedReviewOutcome): Promise<SessionItem> {
    const parsed = reviewOutcomeSchema.parse(outcome);
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }

    const patch: SessionPatch =
      parsed.status === "discarded"
        ? { reviewOutcome: parsed, status: "done" }
        : { reviewOutcome: parsed, status: "writing", attempts: 0 };

    const updated = await this.#modifySession(id, (current) => {
      if (current.status !== "awaiting-review") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "awaiting-review", so a review ` +
            "cannot be submitted for it. Another tab or an earlier submission has already moved it on.",
        );
      }
      const merged = { ...current, ...patch };
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  /**
   * Re-park a session at the review gate — or, when its recording set has moved,
   * at `extracting` so the relay re-extracts first. "Amend" is the user-facing
   * word; the API keeps one method because the body is the same for every source
   * status.
   *
   * **`awaiting-review`, `done` and `dead` are the legal source statuses.** Any
   * ACTIVE status is refused, because it would race the relay — that is the line,
   * not finishedness.
   *
   * `awaiting-review` is here because a recording can be added to a session that
   * is already parked: `enqueue` never looks at the session's status, and the
   * relay transcribes the new recording regardless. That left a parked draft
   * covering fewer recordings than the session holds, with no way out —
   * `closeSession` refuses anything but `open`, and this method used to refuse
   * anything but `done`/`dead`. The reviewer would open a draft with the later
   * clip missing and nothing saying so. Re-parking from `awaiting-review` with an
   * unchanged recording set is a deliberate no-op beyond resetting `attempts`.
   *
   * The guard's reasoning for `done` used to be that reopening would double-write,
   * and that a second review could not update what a first one created because
   * `write` returned no vendor identifier. **Both halves are now out of date.**
   * `write` returns the created record's uuid, `toInstanceWriteStep` checkpoints it
   * through `recordReceipt` as each instance lands, and a later attempt updates the
   * receipted uuid rather than creating again — so a reopened `done` session
   * amends its own records instead of duplicating them. What still justifies the
   * guard is narrower: a reopen is a human decision, and the receipts it will
   * amend against must exist before one is taken.
   *
   * Also refused: a session missing `extracted` OR missing
   * `extractedFromRecordingIds`. Both are needed to re-present the extraction
   * for review — `extracted` is the draft, and `extractedFromRecordingIds`
   * names the recordings whose transcripts produced it (the grounding source).
   * The refusal message branches on which terminal status was found, since
   * "already written" and "gave up" are different things to explain.
   *
   * Clears the stale `reviewOutcome` and resets `attempts` to `0` — the
   * reviewer changed something, so the previous cycle's exhaustion says nothing
   * about this one's chances. `lastError` is deliberately left — it explains
   * why the session needed reopening.
   *
   * ## Where it lands, and why that is a decision
   *
   * **`awaiting-review` when the recording set is unchanged** — the common case,
   * a correction to what was already captured. Re-extraction costs a model call
   * over the whole field set, and there is nothing new for it to read.
   *
   * **`extracting` when the set has moved**, so the relay re-extracts and then
   * parks the session for review. Without this, an auditor who submitted, then
   * remembered the attic and recorded a fourth clip, would reopen onto the draft
   * computed before that clip existed — reviewing a document with the attic
   * missing, and nothing anywhere saying so. `closeSession` cannot rescue them:
   * it refuses any status but `open`.
   *
   * The comparison is against every recording that is not `discarded` or `dead`,
   * **not** against the transcribed ones. `extractedFromRecordingIds` holds the
   * transcribed set, so comparing like with like would find nothing new in the
   * exact case this exists for: at the moment of reopen the fourth clip has not
   * transcribed yet. Comparing eligible-to-transcribed is safe because the relay
   * drains recordings before sessions — the clip transcribes, then extraction
   * runs over it. It is symmetric too: discarding a recording after the fact
   * also moves the set, and that extraction is stale in the other direction.
   */
  async reopenForReview(id: string): Promise<SessionItem> {
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }

    // Read before the modify: `incrementalModify` takes a synchronous mutator
    // and this is storage query. Recordings the extraction would never read
    // are excluded, so discarding one does not read as new work forever.
    const eligible = (await this.#captures.list({ sessionId: id }))
      .filter((r) => r.status !== "discarded" && r.status !== "dead")
      .map((r) => r.id)
      .sort();

    const updated = await this.#modifySession(id, (current) => {
      const cached = current.extractedFromRecordingIds ?? [];
      // An empty eligible set never counts as movement — see the note below.
      const setMoved =
        eligible.length > 0 &&
        (cached.length !== eligible.length || eligible.some((rid, i) => rid !== cached[i]));

      if (current.status !== "dead" && current.status !== "done") {
        // `awaiting-review` is accepted ONLY when the recording set has moved,
        // and that condition is load-bearing twice over.
        //
        // It is what gives a parked session a way out at all: `enqueue` never
        // looks at the session's status, so a recording can be added to a
        // session already sitting at the review gate, and the relay transcribes
        // it. That left a draft covering fewer recordings than the session
        // holds, with no move available — `closeSession` refuses anything but
        // `open`, and this method used to refuse anything but `done`/`dead`.
        //
        // And it is what keeps re-parking a NON-stale session an error rather
        // than a silent no-op. Two tabs racing to rescue the same session must
        // still settle as one winner and one refusal: the loser reads the
        // already-parked document with an unchanged set and is told so. Accepting
        // `awaiting-review` unconditionally would make both callers succeed and
        // would make an implementation that lost the race indistinguishable from
        // one that won it — see `storage-reopen-cross-tab.browser.test.ts`.
        if (current.status !== "awaiting-review" || !setMoved) {
          throw new Error(
            `outbox: session ${id} is "${current.status}" with ` +
              `${setMoved ? "a changed" : "an unchanged"} recording set, so there is nothing to ` +
              "re-park. A finished session can be reopened; a parked one can be refreshed only " +
              "when a recording has been added or discarded since its extraction.",
          );
        }
      }
      // "Already written" and "gave up" are different things to explain, and
      // the caller is looking at one of them. A `done` session told it "never
      // reached extraction" is being described as the opposite of what it is.
      const because =
        current.status === "done"
          ? "this session completed its write, so amending it means reviewing that extraction again"
          : current.status === "dead"
            ? "this session gave up before completing, so reopening it means reviewing what it had"
            : "this session is already parked for review, so re-parking it only refreshes the draft";

      if (current.extracted === undefined) {
        throw new Error(
          `outbox: session ${id} is "${current.status}" but has no extracted data to review — ` +
            `${because}, and there is none to re-park it with.`,
        );
      }
      if (current.extractedFromRecordingIds === undefined) {
        throw new Error(
          `outbox: session ${id} is "${current.status}" and has extracted data but no recording ` +
            `ids, so the extraction's provenance is lost — ${because}, and there is nothing to ` +
            "ground the extracted values against.",
        );
      }

      // On `setMoved` above: an empty eligible set never counts as movement.
      // Every recording being gone does make the stored draft stale, but
      // re-extracting over no transcript would replace it with nothing, which is
      // worse than re-presenting what the model last said. (Whether such a
      // session should be reviewable at all is an older open question — the
      // session-entity design's §12.1 — and this does not answer it.)

      const merged = {
        ...current,
        status: setMoved ? ("extracting" as const) : ("awaiting-review" as const),
        attempts: 0,
      };
      delete merged.reviewOutcome;
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  async #modifySession(
    id: string,
    modify: (data: SessionDocument) => SessionDocument,
  ): Promise<StoredDocument> {
    return await this.#backend.modify("sessions", id, (current) =>
      modify(current as unknown as SessionDocument),
    );
  }

  #toSession(document: StoredDocument): SessionItem {
    // The backend hands back exactly the persisted fields, so the `strictObject`
    // parse survives with no scrubbing. Sessions carry no blobs, so unlike a
    // capture there is nothing derived to look up and this stays synchronous.
    return sessionItemSchema.parse(document);
  }
}

/** {@link SessionQuery} → the port's sessions finder. Same rationale as {@link captureFinder}. */
function sessionFinder({ status, ref, limit }: SessionQuery): Finders["sessions"] {
  return {
    ...(status === undefined ? {} : { status: [status].flat() }),
    ...(ref === undefined ? {} : { ref }),
    ...(limit === undefined ? {} : { limit }),
  };
}
