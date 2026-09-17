import { expect, test } from "vitest";

import { DEFAULT_OUTBOX_DATABASE_NAME } from "./database.js";

/**
 * @file The database name that exists on real devices, pinned as a literal.
 *
 * The sibling of `@azx/ribo-core`'s `persisted-names.test.ts`, and the more
 * dangerous half. A wrong collection name is refused by RxDB (DB5) and fails
 * loudly; a wrong **database** name is perfectly valid — it just opens a
 * different, empty IndexedDB database. Every test in this repo would still pass,
 * because the durability suites generate unique names per test and never touch
 * the default. The only thing that would notice is a device in the field, whose
 * recordings are still on disk under the old name with nothing left that looks
 * for them.
 *
 * This is pinned because the rename genuinely changed it: a blanket identifier
 * replacement matched inside the string and produced `"ribo-storage"`. Nothing
 * else in the tree would have caught it.
 */
test("the default database name is exactly what is on disk", () => {
  expect(DEFAULT_OUTBOX_DATABASE_NAME).toBe("ribo-outbox");
});
