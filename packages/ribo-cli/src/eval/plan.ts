/**
 * @file The eval command's reviewed-plan boundary. One artifact is read and
 * compared for the whole invocation, every selected arm is proved constructable
 * without a transport, and core's dry run supplies the planned call targets the
 * spend guard measures. Eval never updates or repairs the artifact.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseSchemaPlan,
  planFingerprint,
  plannedPerGroupPlan,
  schemaPlanSchema,
} from "@azx/ribo-core";
import type {
  CapableChatClient,
  ChatRequest,
  ExtractionTarget,
  FieldDescriptionsMode,
  SchemaPlan,
} from "@azx/ribo-core";

import type { LoadedCorpus } from "../corpus.js";
import { schemaPlanFreshness, schemaPlanUpdateCommand } from "../schema-plan/freshness.js";
import { buildArm } from "./arm.js";
import { EvalError } from "./error.js";
import { buildEvalTarget } from "./target.js";
import type { EvalSettings, EvalSettingsInput } from "./types.js";

export type PlannedEvalTarget = ExtractionTarget<Record<string, unknown>>;

export interface PreparedEvalPlan {
  readonly plan: SchemaPlan;
  readonly notes: readonly string[];
}

export interface PlannedDryRunInput {
  readonly target: PlannedEvalTarget;
  readonly plan: SchemaPlan;
  readonly settings: EvalSettingsInput;
  readonly fieldDescriptions?: FieldDescriptionsMode;
}

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class PlanConstructionChatInvoked extends Error {
  constructor(request: ChatRequest) {
    super(
      `planned eval construction made a chat call it must never make ` +
        `(schema name "${request.responseFormat.json_schema.name}")`,
    );
  }
}

const constructionChat: CapableChatClient = {
  engine: "planned-eval-construction",
  capability: () => Promise.resolve({ status: "ready" }),
  complete: (request) => {
    throw new PlanConstructionChatInvoked(request);
  },
};

function readPlan(path: string): SchemaPlan {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new EvalError(
      `eval: the schema plan at ${path} could not be read: ${faultMessage(error)} ` +
        "(fix: pass a readable schema-plan file)",
    );
  }
  if (raw.trim() === "") {
    throw new EvalError(
      `eval: the schema plan at ${path} was empty (fix: supply a complete schema-plan artifact)`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new EvalError(
      `eval: the schema plan at ${path} is not valid JSON: ${faultMessage(error)} ` +
        "(fix: repair the JSON input)",
    );
  }
  const parsed = schemaPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalError(
      `eval: the schema plan at ${path} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`)
        .join("; ")} (fix: pass a complete schema-plan artifact)`,
    );
  }
  return parsed.data;
}

const targetList = (
  entry: PlannedEvalTarget | readonly PlannedEvalTarget[],
): readonly PlannedEvalTarget[] =>
  Array.isArray(entry) ? (entry as readonly PlannedEvalTarget[]) : [entry as PlannedEvalTarget];

/** Core's actual packed targets under the run's caps; construction never calls chat. */
export function plannedEvalDryRunTargets({
  target,
  plan,
  settings,
  fieldDescriptions,
}: PlannedDryRunInput): readonly PlannedEvalTarget[] {
  const compiled = plannedPerGroupPlan({
    target,
    plan,
    chat: constructionChat,
    model: settings.model,
    ...(settings.responseCap === undefined ? {} : { maxTokens: settings.responseCap }),
    ...(settings.splitCaps?.maxNullableUnionsPerGroup === undefined
      ? {}
      : { maxNullableUnionsPerGroup: settings.splitCaps.maxNullableUnionsPerGroup }),
    ...(settings.splitCaps?.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: settings.splitCaps.maxSerializedCharsPerGroup }),
    ...(fieldDescriptions === undefined ? {} : { fieldDescriptions }),
  });
  return Object.values(
    compiled.targets as unknown as Record<string, PlannedEvalTarget | readonly PlannedEvalTarget[]>,
  ).flatMap(targetList);
}

/**
 * Read one plan for all matching arms, diagnose membership before coverage
 * parsing, then construct every arm against a chat that cannot be called.
 */
export async function prepareEvalPlan(
  corpus: LoadedCorpus,
  arms: readonly EvalSettingsInput[],
  path: string,
): Promise<PreparedEvalPlan> {
  const artifact = readPlan(path);
  const schemaPath = resolve(corpus.root, corpus.manifest.schema);
  const freshness = schemaPlanFreshness(corpus.schemaDocument, artifact);
  if (freshness.status === "stale") {
    throw new EvalError(
      `eval: the schema plan is stale: ${freshness.notes.join("; ")}; ` +
        `fix: ${schemaPlanUpdateCommand(schemaPath, path, artifact)}`,
    );
  }

  let plan: SchemaPlan;
  try {
    plan = parseSchemaPlan(artifact, corpus.schema);
  } catch (error) {
    throw new EvalError(
      `eval: the schema plan does not cover the corpus schema — ${faultMessage(error)} ` +
        `(fix: ${schemaPlanUpdateCommand(schemaPath, path, artifact)})`,
    );
  }

  const fingerprint = await planFingerprint(plan);
  for (const arm of arms) {
    const planned = arm.strategies.includes("planned");
    try {
      const { target, groups } = buildEvalTarget(
        corpus.schema,
        corpus.manifest.prompt,
        corpus.manifest.name,
        arm.splitCaps ?? {},
        // Only the presence-narrowed strategy consumes the walked groups; the
        // walk (and its refusal) stays scoped to arms that select it.
        arm.strategies,
      );
      const settings: EvalSettings = {
        ...arm,
        ...(planned ? { planFingerprint: fingerprint } : {}),
      };
      buildArm({
        target,
        groups,
        chat: constructionChat,
        model: settings.model,
        settings,
        ...(planned ? { plan } : {}),
        groupInstructions: (groupKey: string): string =>
          corpus.manifest.prompt.groupInstructions?.[groupKey] ??
          corpus.manifest.prompt.instructions,
        ...(corpus.manifest.prompt.fieldDescriptions === undefined
          ? {}
          : { fieldDescriptions: corpus.manifest.prompt.fieldDescriptions }),
      });
    } catch (error) {
      if (error instanceof PlanConstructionChatInvoked) throw error;
      if (error instanceof EvalError) throw error;
      if (!planned) {
        throw new EvalError(
          `eval: the ${arm.strategies.join(" → ")} arm could not be built — ${faultMessage(error)}`,
        );
      }
      throw new EvalError(
        `eval: the planned call layout could not be constructed — ${faultMessage(error)} ` +
          "(fix: correct the reviewed plan or the split caps)",
      );
    }
  }
  return { plan, notes: freshness.notes };
}
