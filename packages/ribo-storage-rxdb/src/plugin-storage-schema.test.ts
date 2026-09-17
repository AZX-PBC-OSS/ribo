import { expect, test } from "vitest";

import {
  ENTRY_SCOPE_KINDS,
  PLUGIN_STORAGE_COLLECTION_NAME,
  pluginStorageDocumentSchema,
  pluginStorageEntryId,
} from "@azx/ribo-core";
import { PLUGIN_STORAGE_MIGRATION_STRATEGIES, pluginStorageRxSchema } from "./schemas.js";

// Same drift guard `schema.test.ts` and `session-schema.test.ts` provide for
// their collections: the zod schema (the trust boundary) and the RxDB JSON
// schema (which carries primary key and index metadata) describe the same
// document, and these tests pin them together so a field added to one but not
// the other fails here rather than after a reload.

const zodKeys = Object.keys(pluginStorageDocumentSchema.shape).sort();

test("the RxDB schema describes exactly the fields the zod schema does", () => {
  expect(Object.keys(pluginStorageRxSchema.properties).sort()).toEqual(zodKeys);
});

test("every field is required — plugin storage has no optional fields", () => {
  const required = [...(pluginStorageRxSchema.required ?? [])].sort();
  expect(required).toEqual(zodKeys);
});

test("the primary key is a required field, as RxDB demands", () => {
  expect(pluginStorageRxSchema.primaryKey).toBe("id");
  expect(pluginStorageRxSchema.required).toContain("id");
});

test("the [scopeKind, scopeId] compound index serves the sweep", () => {
  // The sweep deletes every entry for a dropped capture in one query, so it
  // must be an index lookup rather than a scan.
  expect(pluginStorageRxSchema.indexes).toContainEqual(["scopeKind", "scopeId"]);
});

test("the compound [scopeKind, scopeId, owner] index serves per-owner reads", () => {
  expect(pluginStorageRxSchema.indexes).toContainEqual(["scopeKind", "scopeId", "owner"]);
});

test("the bare owner index serves the owner-wide enumeration", () => {
  expect(pluginStorageRxSchema.indexes).toContainEqual(["owner"]);
});

test("the collection name is distinct from the outbox and sessions", () => {
  expect(PLUGIN_STORAGE_COLLECTION_NAME).toBe("pluginStorage");
  expect(PLUGIN_STORAGE_COLLECTION_NAME).not.toBe("outbox");
  expect(PLUGIN_STORAGE_COLLECTION_NAME).not.toBe("sessions");
});

test("the RxDB schema is at version 1, with exactly the v0 → v1 strategy declared", () => {
  expect(pluginStorageRxSchema.version).toBe(1);
  expect(Object.keys(PLUGIN_STORAGE_MIGRATION_STRATEGIES)).toEqual(["1"]);
});

test("attachments are enabled — consistent with the sibling collections", () => {
  expect(pluginStorageRxSchema.attachments).toBeDefined();
});

test("pluginStorageEntryId is collision-safe across owners, scopes and keys", () => {
  const a = pluginStorageEntryId("cap-1", "owner-A", "key");
  const b = pluginStorageEntryId("cap-1", "owner-B", "key");
  const c = pluginStorageEntryId("cap-2", "owner-A", "key");
  const d = pluginStorageEntryId("cap-1", "owner-A", "other");
  expect(new Set([a, b, c, d]).size).toBe(4);
});

test("pluginStorageEntryId is deterministic — same inputs produce the same id", () => {
  expect(pluginStorageEntryId("cap-1", "owner-A", "key")).toBe(
    pluginStorageEntryId("cap-1", "owner-A", "key"),
  );
});

test("pluginStorageEntryId does not encode the scope kind — the deliberate trade", () => {
  // The same owner, scope id and key are ONE row regardless of what the entry
  // is scoped to. Encoding the kind would rewrite every existing row's primary
  // key during the migration, and a primary-key rewrite fails by making rows
  // unreachable rather than by erroring — so the composition stays exactly what
  // version 0 wrote, and the kinds lean on scope ids being disjoint.
  expect(pluginStorageEntryId("cap-1", "owner-A", "key")).toBe(
    pluginStorageEntryId("cap-1", "owner-A", "key"),
  );
  expect(pluginStorageEntryId("cap-1", "owner-A", "key")).toBe(`owner-A\x00cap-1\x00key`);
});

test("a valid document parses", () => {
  const parsed = pluginStorageDocumentSchema.safeParse({
    id: pluginStorageEntryId("cap-1", "owner-A", "key"),
    scopeKind: "capture",
    scopeId: "cap-1",
    owner: "owner-A",
    key: "key",
    value: JSON.stringify({ hello: "world" }),
  });
  expect(parsed.success).toBe(true);
});

test("every declared scope kind parses — the v1 schema ships the session kind", () => {
  // The kind is on disk even though no session accessor ships yet: paying for
  // the migration once is the point, and adding the accessor later needs no
  // second migration.
  for (const kind of ENTRY_SCOPE_KINDS) {
    expect(
      pluginStorageDocumentSchema.safeParse({
        id: pluginStorageEntryId("cap-1", "owner-A", "key"),
        scopeKind: kind,
        scopeId: "cap-1",
        owner: "owner-A",
        key: "key",
        value: "{}",
      }).success,
    ).toBe(true);
  }
});

test("a document with an unknown scope kind is rejected", () => {
  expect(
    pluginStorageDocumentSchema.safeParse({
      id: pluginStorageEntryId("cap-1", "owner-A", "key"),
      scopeKind: "workspace",
      scopeId: "cap-1",
      owner: "owner-A",
      key: "key",
      value: "{}",
    }).success,
  ).toBe(false);
});

test("a document missing a required field is rejected", () => {
  expect(
    pluginStorageDocumentSchema.safeParse({
      id: "x",
      scopeKind: "capture",
      scopeId: "cap-1",
      owner: "owner-A",
      key: "key",
      // value missing
    }).success,
  ).toBe(false);
});

test("a document with an extra field is rejected — strictObject", () => {
  expect(
    pluginStorageDocumentSchema.safeParse({
      id: "x",
      scopeKind: "capture",
      scopeId: "cap-1",
      owner: "owner-A",
      key: "key",
      value: "{}",
      extra: true,
    }).success,
  ).toBe(false);
});
