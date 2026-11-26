/** Deterministic, code-owned OpenAPI 3.0 rendering over validated declarations. */
import { convertDocument } from "../inspect/convert.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { OperatorError } from "../operator/error.js";
import type {
  SchemaInitLeafDeclaration,
  SchemaInitNodeDeclaration,
  SchemaInitObjectDeclaration,
  SchemaInitProposal,
} from "./proposal.js";

/** A rendered scalar leaf in the dialect inspect accepts. */
export interface SchemaInitOpenApiLeaf {
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  readonly enum?: readonly string[];
  readonly nullable?: true;
}

/** A rendered collection of objects. */
export interface SchemaInitOpenApiCollection {
  readonly type: "array";
  readonly description: string;
  readonly items: SchemaInitOpenApiObject;
}

/** A rendered plain object, with optional leaves omitted from `required`. */
export interface SchemaInitOpenApiObject {
  readonly type: "object";
  readonly description: string;
  readonly properties: Readonly<Record<string, SchemaInitOpenApiNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** Any node in the code-rendered document. */
export type SchemaInitOpenApiNode =
  SchemaInitOpenApiObject | SchemaInitOpenApiCollection | SchemaInitOpenApiLeaf;

const renderLeaf = (leaf: SchemaInitLeafDeclaration): SchemaInitOpenApiLeaf => ({
  type: leaf.kind,
  description: leaf.description,
  ...(leaf.enum === undefined ? {} : { enum: leaf.enum.map((member) => member.value) }),
  ...(leaf.optional === true ? { nullable: true as const } : {}),
});

const isRequired = (node: SchemaInitNodeDeclaration): boolean =>
  node.kind === "object" || node.kind === "collection" || node.optional !== true;

const renderObject = (object: SchemaInitObjectDeclaration): SchemaInitOpenApiObject => {
  const properties = Object.fromEntries(
    object.properties.map((property) => [property.name, renderNode(property.node)]),
  ) as Record<string, SchemaInitOpenApiNode>;
  const required = object.properties
    .filter((property) => isRequired(property.node))
    .map((property) => property.name);
  return {
    type: "object",
    description: object.description,
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
};

const renderNode = (node: SchemaInitNodeDeclaration): SchemaInitOpenApiNode => {
  if (node.kind === "object") return renderObject(node);
  if (node.kind === "collection") {
    return { type: "array", description: node.description, items: renderObject(node.items) };
  }
  return renderLeaf(node);
};

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Render and then prove the result through inspect's real converter and inventory walk. */
export function renderSchemaInitProposal(proposal: SchemaInitProposal): SchemaInitOpenApiObject {
  const document = renderObject(proposal.root);
  try {
    walkFieldInventory(convertDocument(document));
  } catch (error) {
    throw new OperatorError(
      `schema init's rendered draft failed inspect conversion or field walking: ${faultMessage(error)}`,
    );
  }
  return document;
}
