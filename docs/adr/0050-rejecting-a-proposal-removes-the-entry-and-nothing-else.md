# 0050. Rejecting a proposal removes the entry and nothing else

Status: Accepted
Date: 2026-11-27

## Context

ADR 0049 said `--reject --leaf <path>` removes a pending entry "so the leaf is unmentioned". That
holds only when nothing else covers the leaf. A corpus may carry an author's default that does
apply to it, and an unmentioned leaf resolves through that default before it is ever unmentioned.
The sentence therefore promised more than removal can deliver.

## Decision

`--reject` deletes the pending explicit entry and does nothing more. The leaf then resolves exactly
as the corpus would have resolved it had the proposal never been written: through a covering
default if one exists, else unmentioned. Reject never edits a default, and it never writes an
explicit unmentioned entry in place of the one it removed. The docs state this, and tests cover
reject with and without a covering default.

Rejected: writing an explicit unmentioned entry — it would override an author's default the
reviewer never looked at, and it is a new authored claim rather than the removal of a proposed one.
Rejected: editing defaults — authored work is never touched (ADR 0049's additive rule).
