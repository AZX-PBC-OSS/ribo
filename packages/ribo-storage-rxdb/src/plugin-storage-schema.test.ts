import { expect, test } from "vitest";

import {
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

test("captureId is indexed so the sweep is an index lookup", () => {
  expect(pluginStorageRxSchema.indexes).toContain("captureId");
});

test("the compound [captureId, pluginId] index serves per-plugin reads", () => {
  expect(pluginStorageRxSchema.indexes).toContainEqual(["captureId", "pluginId"]);
});

test("the collection name is distinct from the outbox and sessions", () => {
  expect(PLUGIN_STORAGE_COLLECTION_NAME).toBe("pluginStorage");
  expect(PLUGIN_STORAGE_COLLECTION_NAME).not.toBe("outbox");
  expect(PLUGIN_STORAGE_COLLECTION_NAME).not.toBe("sessions");
});

test("the RxDB schema is at version 0 — the collection is new, no migration needed", () => {
  expect(pluginStorageRxSchema.version).toBe(0);
  expect(Object.keys(PLUGIN_STORAGE_MIGRATION_STRATEGIES)).toEqual([]);
});

test("attachments are enabled — consistent with the sibling collections", () => {
  expect(pluginStorageRxSchema.attachments).toBeDefined();
});

test("pluginStorageEntryId is collision-safe across plugins, captures and keys", () => {
  const a = pluginStorageEntryId("cap-1", "plugin-A", "key");
  const b = pluginStorageEntryId("cap-1", "plugin-B", "key");
  const c = pluginStorageEntryId("cap-2", "plugin-A", "key");
  const d = pluginStorageEntryId("cap-1", "plugin-A", "other");
  expect(new Set([a, b, c, d]).size).toBe(4);
});

test("pluginStorageEntryId is deterministic — same inputs produce the same id", () => {
  expect(pluginStorageEntryId("cap-1", "plugin-A", "key")).toBe(
    pluginStorageEntryId("cap-1", "plugin-A", "key"),
  );
});

test("a valid document parses", () => {
  const parsed = pluginStorageDocumentSchema.safeParse({
    id: pluginStorageEntryId("cap-1", "plugin-A", "key"),
    captureId: "cap-1",
    pluginId: "plugin-A",
    key: "key",
    value: JSON.stringify({ hello: "world" }),
  });
  expect(parsed.success).toBe(true);
});

test("a document missing a required field is rejected", () => {
  expect(
    pluginStorageDocumentSchema.safeParse({
      id: "x",
      captureId: "cap-1",
      pluginId: "plugin-A",
      key: "key",
      // value missing
    }).success,
  ).toBe(false);
});

test("a document with an extra field is rejected — strictObject", () => {
  expect(
    pluginStorageDocumentSchema.safeParse({
      id: "x",
      captureId: "cap-1",
      pluginId: "plugin-A",
      key: "key",
      value: "{}",
      extra: true,
    }).success,
  ).toBe(false);
});
