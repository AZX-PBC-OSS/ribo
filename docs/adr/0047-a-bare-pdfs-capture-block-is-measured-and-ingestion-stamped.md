# 0047. A bare PDF's capture block is measured and ingestion-stamped

Status: Accepted
Date: 2026-11-27

## Context

The schema-plan plan's decision D11 said, verbatim:

> Init accepts direct text and document case folders; optional corpus creation is explicit. Case
> folders preserve required capture metadata and avoid inventing PDF dates/page counts. Direct
> PDFs would require a new metadata interface without benefit over the existing format.

The trial that followed found the direct-PDF refusal the largest single blocker: bare PDFs are
what users actually hold, and a trial user abandoned init at exactly that refusal. The refusal's
sound half was "never guess metadata" — a `DocumentCapture` requires `pageCount` and `capturedAt`,
and inventing either is fabrication. Its unsound half was the conclusion: the metadata does not
have to be guessed, because a page count can be measured from the file itself, and an ingestion
instant can be stamped rather than inferred.

## Decision

Schema init accepts a bare PDF as a one-input document sample named after the file. Its capture
block is produced, never guessed: `pageCount` is measured from the file through the same resolved
pdf.js legacy build and worker path eval's transcription uses, and `capturedAt` is the instant the
init run took the file in — the command clock read once per run, or an explicit `--captured-at`
ISO 8601 datetime, which is refused when no sample is a bare PDF. No file mtime and no PDF
metadata date is ever read; a case folder's declared capture block is passed through untouched.
The measurement runs before the spend estimate, and every refusal — an encrypted or unreadable
PDF, a file with PDF magic bytes but no `.pdf` extension — names the file and lands before any
transcription, estimate or model call.

This overturns exactly one statement of the schema-plan plan's D11: that direct PDFs bring no
benefit over the existing format. D11's other rule stands unchanged — metadata is never invented,
which is why the capture block is measured and stamped instead of guessed.

## Consequences

The trial's largest blocker is gone, and the series' later tickets — plain job folders, the draft
subset — can assume bare PDFs load. `capturedAt` now means "when the file entered the corpus",
not "when the document was captured"; that is honest provenance and is what the corpus format's
own wording now says, with scoring and the freshness fingerprint reading neither. The cost is a
wider refusal surface at load time — an unreadable PDF is refused before the draft rather than
being handed to transcription — and one more flag on an already flag-heavy command, justified by
the refusal of the alternatives: reading the file's mtime bakes in whatever the file system
happens to say (a copy, a checkout or a sync changes it), reading a PDF metadata date trusts an
unsigned, often-absent string inside the artifact being measured, and requiring `--captured-at`
restores the abandonment the trial measured.
