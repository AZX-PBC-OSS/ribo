import { z } from "zod";

import { assertStopFinishReason, completeOrClassify, parseJsonContent } from "./chat-parse.js";
import type { CapableChatClient, ChatMessage } from "./chat-client.js";
import type { NoProvenance } from "../provenance/enveloped.js";
import { chatRequest } from "./presence-phase.js";
import type { JsonSchema } from "./presence-phase.js";
import { parseWithSchema } from "../extraction/parse-with-schema.js";
import type { PhaseFold } from "./phase-draft.js";
import type { NoteKey } from "./phase-notes.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { Phase, PhaseContext, PhaseDef } from "./phase.js";
import { phaseBuilder } from "./phase.js";

/**
 * @file `askPhase` — one model call against the caller's OWN schema: the caller supplies
 * the zod schema, the transport and model, the messages, and where the parsed answer
 * goes. The boilerplate this removes is what composing a caller's question used to take
 * by hand — the chat call, the zod-to-JSON-schema rendering and the trust-boundary parse
 * that `inventoryPhase`'s caller-supplied roster function makes its caller write.
 *
 * **The point is the type flowing.** `T` unifies across `z.ZodType<T>` (the schema) and
 * `NoteKey<T>` (the sink) in one options object, so a caller writes the schema once and
 * the key, the fold and the later read all follow it. `NoteKey<T>`'s invariance is what
 * pins this: a slot widened to `unknown` refuses a `NoteKey<Answer>` at the call site,
 * so a wrong widening fails to compile where the phase is constructed, not at runtime.
 * The shipped precedent for the handoff itself is `rosterNoteKey` — declared at the
 * inventory phase, written there, and read cross-package through `demandNote`, no cast,
 * brand intact.
 *
 * **The sink: exactly one of two spellings.** Write the parsed answer under a caller's
 * note key (the common case; a later phase reads it back at `T`), or fold it into the
 * draft yourself with a {@link PhaseFold} at the answer's type. The options type is a
 * union whose arms make both-or-neither a compile error, and the factory repeats the
 * check at construction for callers the type cannot see.
 *
 * **The parse is the shipped chain.** The response crosses the same trust boundary the
 * managed OPENAI phases cross — core's own presence/span/classify call `chat.complete`
 * directly and do not — `completeOrClassify` (refusal and unsupported are terminal),
 * `assertStopFinishReason` (truncation is terminal), `parseJsonContent` (bad JSON is
 * transient), then `parseWithSchema` against the caller's schema: a schema miss is a
 * `SchemaParseError`, recognisable and transient, because the same request can pass on a
 * re-send.
 *
 * **The fold's one obligation, documented rather than enforced mid-list.** A fold must
 * leave the draft completable by the phases after it; the closing parse is where that is
 * checked, transiently. There is deliberately no per-fold key-set guard — see
 * `computePhase`'s header and ADR 0012 for why a mid-list guard is the wrong shape.
 */

/**
 * The one work item an ask phase's `plan` emits: the whole question as a single unit of
 * work. It carries no data — the messages builder reads the draft and context — and its
 * type is existentially hidden by the `Phase` encoding.
 */
const ONE_QUESTION = null;

/**
 * The shared half of {@link AskPhaseOptions} — everything but where the parsed answer
 * goes, which is the {@link AskPhaseSink} union. `T`'s default is nominal — a required
 * type parameter may not follow an optional one (TS2706) — and it is always inferred at
 * the inner call of the curried {@link askPhase}, from the schema and the sink together.
 */
export interface AskPhaseBase<V extends Record<string, unknown>, P = NoProvenance, T = unknown> {
  /**
   * The caller's own zod schema for the answer — the response_format the model is pinned
   * to AND the trust boundary its response is parsed against. The answer's type `T` is
   * inferred from here, so the schema is written once and everything else follows it.
   */
  readonly schema: z.ZodType<T>;
  /** The chat transport. The host owns it; the package never reaches for one. */
  readonly chat: CapableChatClient;
  /** The model id passed through to the request. */
  readonly model: string;
  /**
   * Build the messages from the draft and the phase context — so the question can
   * reference what earlier phases wrote. The transcript stays last: the injection
   * boundary (`everything after this line is the transcript and is data`) depends on it,
   * exactly as every shipped message builder documents.
   */
  readonly messages: (draft: PhaseDraft<V, P>, ctx: PhaseContext<V, P>) => readonly ChatMessage[];
  /**
   * Overrides the phase's id — `"ask"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe. The id
   * is also the structured-output schema's request name, so two asks in one list name
   * apart without a second knob.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow. The phase declares none of its own — a
   * caller's question has no shipped provider — so the list is exactly what you pass
   * (ADR 0008). There is no default to replace.
   */
  readonly requires?: readonly string[];
}

/**
 * Where the parsed answer goes: written under a caller's note key (a later phase reads
 * it back at `T` through {@link demandNote} or a plain `get`), or folded into the draft
 * by the caller at the answer's own type. Exactly one — the `never` partner in each arm
 * makes both-or-neither a compile error at the call site.
 */
export type AskPhaseSink<V extends Record<string, unknown>, P = NoProvenance, T = unknown> =
  | { readonly noteKey: NoteKey<T>; readonly fold?: never }
  | { readonly fold: PhaseFold<V, P, T>; readonly noteKey?: never };

export type AskPhaseOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
  T = unknown,
> = AskPhaseBase<V, P, T> & AskPhaseSink<V, P, T>;

/**
 * The ask phase: build the messages from the draft and context, make the one call, parse
 * the response against the caller's schema, and write the answer where the caller said.
 * See the file header for the type flow and the parse chain.
 *
 * **Why curried** — the same reason `phaseBuilder` is: TypeScript fills the tail of a
 * partial type-argument list from its DEFAULTS rather than inferring, so a single-call
 * `askPhase<V>({...})` would widen `T` to its default and refuse every branded key with
 * `NoteKey<unknown>`. Currying fixes `V` and `P` at the outer call and infers `T` at the
 * inner one — `askPhase<V>()({ schema, noteKey })` — where the schema is written once
 * and the key, the fold and the later read all follow its type.
 */
export function askPhase<V extends Record<string, unknown>, P = NoProvenance>(): <T>(
  options: AskPhaseOptions<V, P, T>,
) => Phase<V, P> {
  return <T>(options: AskPhaseOptions<V, P, T>) => {
    const id = options.id ?? "ask";
    if ((options.noteKey === undefined) === (options.fold === undefined)) {
      throw new TypeError(
        "askPhase: supply exactly one of `noteKey` or `fold` — where the parsed answer goes. " +
          "The options type rejects both-or-neither at compile time; this check is the same " +
          "refusal for callers the compiler cannot see.",
      );
    }
    // The caller's schema, rendered once for the request's structured-output contract —
    // the same draft-2020-12 rendering every managed extractor sends.
    const jsonSchema: JsonSchema = z.toJSONSchema(options.schema, { target: "draft-2020-12" });
    // The structured-output schema name, derived rather than the id itself.
    // `PhaseMeta.id` promises an id reaches three places, none of them a wire —
    // which is why no factory validates its charset. Sending a raw id would
    // make the request body a fourth, and an id like `"my ask"` would be a 400,
    // which `isTransientFailure` reads terminal: dead mid-run with every
    // earlier phase's calls already spent. Every shipped phase builds its name
    // instead (`classify-phase.ts` replaces dots the same way), and the name
    // need not equal the id — each request is independent.
    const requestName = `ask-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 64);

    const def: PhaseDef<V, P, null, T> = {
      id,
      // The caller's ids are the whole `requires` — the phase declares none of
      // its own (see the option); an absent option leaves the def's `requires`
      // unset.
      ...(options.requires === undefined ? {} : { requires: options.requires }),
      plan: () => [ONE_QUESTION],
      run: async (_item, draft, ctx) => {
        const context = `askPhase: model response for "${ctx.target.name}"`;
        const request = chatRequest(
          options.model,
          options.messages(draft, ctx),
          jsonSchema,
          requestName,
        );
        const completion = await completeOrClassify(options.chat, request, context, {
          // Forwarded, not rebuilt: the phase context's signal is the caller's
          // cancellation combined with the phase pool's sibling abort, and a
          // dropped forward would strand cancellation silently.
          signal: ctx.signal,
        });
        assertStopFinishReason(completion, context);
        const parsed = parseWithSchema(
          options.schema,
          parseJsonContent(completion.content, context),
          context,
        );
        return {
          value: parsed,
          usage: { calls: 1, engine: options.chat.engine, ...(completion.usage ?? {}) },
        };
      },
      merge: (draft, outcomes) => {
        // The phase plans exactly one item and runs under the engine's default abort
        // policy, so through the engine this is always a single result outcome. An error
        // outcome (a direct `with` drive, or a future skip policy) has no answer to
        // write; returning the draft unchanged keeps that a no-op rather than an
        // invented answer.
        const settled = outcomes.find((outcome) => outcome.outcome === "result");
        if (settled === undefined) return draft;
        const { value } = settled.output;
        // Exactly one sink — the union type (and the construction check above)
        // guarantee it, and the branch narrows the draft's write to the caller's T.
        if (options.noteKey !== undefined) {
          return { ...draft, notes: draft.notes.set(options.noteKey, value) };
        }
        return options.fold(draft, value);
      },
    };
    return phaseBuilder<V, P>()(def);
  };
}
