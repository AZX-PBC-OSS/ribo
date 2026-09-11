# Motivation

Getting structured data out of a document is easy to demo and hard to ship.

The demo takes an afternoon: send the text to a model, hand it a JSON schema, get an object back.
It works. You show someone. Then you point it at the real thing, and five problems arrive at once.
None of them is about the model being good enough.

## The schema stops fitting

Your demo schema had eight fields. The system you actually need to write into has hundreds.

One system of record we build against exposes **837 distinct writable fields**. That alone is
awkward. What makes it fatal is provenance: if you want every field to carry a source quote so a
human can check it, each leaf costs its own key plus three more — `value`, `confidence`,
`sourceSpan` — four properties where there was one. Measured against a snapshot of that
specification, the combined job schema came to roughly **5,360 properties against a documented
5,000-property ceiling**, and **~1,490 enum values against a 1,000-value ceiling** — over both, by
margins spec drift won't close.

The request is not slow or expensive. It is _rejected_.

And the ceilings are not uniform. Our own probing found one model family rejecting any response
schema with more than **16 nullable unions** — which, at two per provenance-wrapped field, is
**eight fields per call**. Two groups in our own pilot schema already exceed that.

So the first real problem is not extraction quality. It is that **a single call is the wrong unit of
work**, and everything you build assuming otherwise has to be rebuilt.

## The model cites things that are not there

Ask a model for a value and it gives you one. Ask it how confident it is and it gives you a number.
That number is the model grading its own work; nobody else can check it.

Ask it instead to quote the text it took the value from. Then you can go and look. If the quote is
not in the source, the field is not trustworthy — and you know that mechanically, by string
comparison, without a human and without a second model.

This is measured, not hypothetical. On a real report in this repo, asking for a citation per
**cell** of a wide table produced **37% fabricated citations** (17 of 46). Asking for one citation
per **row** of a separate report's table produced **14 of 14 verbatim**. Different documents, and
only the per-cell run names a model — but in both, the citation unit decided whether the quotes
were real.

That is a design problem with a right answer, and it is not one the model can solve for you.

## Somebody has to check the output

For anything that matters, a person accepts the result before it lands. This is not a UI task you
bolt on at the end; it determines the shape of everything upstream.

Review needs to address individual leaves, not whole objects — otherwise a matrix of independent
test results collapses into one accept-or-reject decision, and the reviewer's only options are to
approve something wrong or reject everything else that was right. It needs each
leaf's own type to render an appropriate editor and validate an edit. It needs the source quote in
view. And it needs the pipeline to actually _stop_ and wait, durably, possibly across a browser
restart.

Getting this wrong is the default. This repo got it wrong first — review addressed top-level keys —
and fixing it changed the type signature of the central adapter interface.

## The network is not there

The work happens in a basement, in a crawlspace, in a building with a meter of concrete between the
device and the nearest cell tower.

A hosted document-understanding API is a network call; that is all it is. Any
architecture whose first step is "upload the document" has already decided that the work stops when
the connection does — and for field data collection, that is most of the time.

Making this work is not a feature you add later. It means the capture is durable from the instant
it exists, the pipeline is a persisted state machine rather than a promise chain, retries have
backoff and survive a reload, and the application shell and any on-device model weights are cached
before you need them.

## It has to land somewhere

Extraction that ends as JSON on a screen is a demo. Extraction that ends as a correct write to the
right record is a product, and the gap between those is real work: a trust boundary
that validates before writing, idempotency so a retry does not double-write, and — hardest —
knowing _which_ record. A house has two furnaces. Your schema says "the furnace". The extraction can
be perfectly typed and still write the upstairs unit's value onto the basement one.

## What Ribo is

Ribo is the answer to those five problems, as a library.

It is **not** a document parser, and it does not want to be. Parsing is a real and separate
specialty; Ribo delegates it through the `Transcriber` seam and composes whatever you plug in.
What Ribo owns is everything between "I have text" and "the record changed" — the part that is
mostly not about models at all.

If you have a small schema, no human in the loop, and a reliable network, you do not need any of
this. Call a structured-output API and be done in twenty lines. [Comparison](/guide/comparison) says
that plainly, and says where the line is.
