/**
 * @file The key-value entry document's shape version and upgrade ladder.
 *
 * The version constant is maintained by hand and is **not** derived from the
 * ladder's length — see `captures.ts` for why.
 */

import type { ShapeUpgrade } from "./rung.js";

export const PLUGIN_STORAGE_DOCUMENT_VERSION = 1;

export const PLUGIN_STORAGE_DOCUMENT_UPGRADES: readonly ShapeUpgrade[] = [
  {
    reason:
      "The scope becomes a kind and an id, and the owner stops being a plugin. " +
      "Field-only: the primary key's composition is deliberately unchanged, because a " +
      "key rewrite fails by making rows unreachable rather than by erroring. " +
      "Required even though no user depends on a v0 entry — RxDB validates against the " +
      "schema the collection was CREATED with, so reshaping at the same version is a " +
      "DB6 on any device that has merely opened the app, and because all three " +
      'collections are added in one call it strands the captures too. "The collection ' +
      'holds no data" answers the data question and leaves the schema question unasked.',
    upgrade: (document) => {
      const v0 = document as {
        id: string;
        captureId: string;
        pluginId: string;
        key: string;
        value: string;
      };
      return {
        id: v0.id,
        // Everything that exists at v0 is capture-scoped: there was nowhere to
        // record any other kind, so there cannot be one.
        scopeKind: "capture",
        scopeId: v0.captureId,
        owner: v0.pluginId,
        key: v0.key,
        value: v0.value,
      };
    },
  },
];
