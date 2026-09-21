import { expect, test } from "vitest";

import { AUDIO_ATTACHMENT_ID, CAPTURES_COLLECTION_NAME } from "./capture-schema.js";
import { chunkName, chunkPrefix } from "./chunk-names.js";
import { PLUGIN_STORAGE_COLLECTION_NAME } from "./plugin-storage-schema.js";
import { SESSION_COLLECTION_NAME } from "./session-schema.js";

/**
 * @file The names that exist on real devices, pinned as literals.
 *
 * These strings are what an auditor's recordings are actually filed under.
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

/**
 * Attachment ids are persisted names too, and the header above was incomplete
 * without them: a collection name is where the ROWS are filed, and these are
 * where the BYTES are. `audio-<sourceId>-000000-00` is the literal key an
 * auditor's recording lives at.
 *
 * They are pinned here for the same reason and against a sharper hazard.
 * Migrations transform documents; no migration in this repository's history has
 * ever touched an attachment, and the upgrade ladders in `upgrades/` cannot
 * express one — a rung is a per-document, synchronous, JSON-only rewrite. So a
 * change to either of these names is not a migration anybody could write here.
 * It orphans the bytes, with no error, on every device that has ever recorded.
 *
 * `capture-schema.ts` already says `sourceId` must NEVER change because it names
 * the chunks. This is that invariant made executable, and extended to the format
 * built around it: the `audio-` prefix, the six-digit chunk index and the
 * two-digit slice index are all part of the stored key. The zero padding is not
 * cosmetic — recovery lists attachments and relies on lexical order matching
 * numeric order, which is why `chunk-names.ts` refuses indices that would
 * overflow the padding.
 */
test("the persisted attachment names are exactly what is on disk", () => {
  expect(AUDIO_ATTACHMENT_ID).toBe("audio");
  expect(chunkPrefix("s1")).toBe("audio-s1-");
  expect(chunkName("s1", 0, 0)).toBe("audio-s1-000000-00");
  expect(chunkName("s1", 42, 7)).toBe("audio-s1-000042-07");
});
