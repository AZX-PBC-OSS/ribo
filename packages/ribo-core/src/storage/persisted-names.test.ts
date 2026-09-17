import { expect, test } from "vitest";

import { CAPTURES_COLLECTION_NAME } from "./capture-schema.js";
import { PLUGIN_STORAGE_COLLECTION_NAME } from "./plugin-storage-schema.js";
import { SESSION_COLLECTION_NAME } from "./session-schema.js";

/**
 * @file The names that exist on real devices, pinned as literals.
 *
 * These four strings are what an auditor's recordings are actually filed under.
 * Change one and every existing device opens an empty collection: the rows are
 * still on disk, reachable by nothing, and the failure is silent — a fresh,
 * working, empty app.
 *
 * The identifiers around them are free to change and have: the constant is now
 * `CAPTURES_COLLECTION_NAME` where it was `OUTBOX_COLLECTION_NAME`, and the
 * subsystem is called storage rather than an outbox. **The values are not free**,
 * and nothing else in the tree says so out loud.
 *
 * This exists because the rename very nearly took them. A blanket identifier
 * replacement matched inside the string literals and turned `"outbox"` into
 * `"storage"` and `"ribo-outbox"` into `"ribo-storage"`. The collection name was
 * caught by RxDB refusing the name (DB5); the *database* name would have opened a
 * different, empty IndexedDB database on every device and passed every test in
 * this repo, because the durability suites all generate unique names.
 *
 * If a future change genuinely needs one of these values to differ, it is a
 * migration with a version bump and a strategy, on the collection where a bad
 * migration strands the field work — not an edit to this file.
 */
test("the persisted collection names are exactly what is on disk", () => {
  expect(CAPTURES_COLLECTION_NAME).toBe("outbox");
  expect(SESSION_COLLECTION_NAME).toBe("sessions");
  expect(PLUGIN_STORAGE_COLLECTION_NAME).toBe("pluginStorage");
});
