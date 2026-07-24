/**
 * @file Facts about *this* page load.
 *
 * Its own module on purpose: a module-scope constant living in a component file
 * would be re-initialised by React Fast Refresh on every edit, and then
 * "enqueued before this page load" — the signal the reload check is built on —
 * would quietly become "enqueued before the last time I saved a file".
 */

/** When this page load happened, ISO 8601, comparable against `item.enqueuedAt`. */
export const PAGE_LOADED_AT = new Date().toISOString();
