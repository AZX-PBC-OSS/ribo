---
layout: home

hero:
  name: Ribo
  text: Structured extraction you can check
  tagline: >-
    Turn a PDF, a dictation, or both at once into structured data — every field carrying a quote
    from the source, checked against it, and accepted by a human before it lands. Offline-first,
    and pluggable at every seam.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/installation
    - theme: alt
      text: Why Ribo
      link: /guide/motivation
    - theme: alt
      text: Compare
      link: /guide/comparison
    - theme: alt
      text: API Reference
      link: /reference/

features:
  - title: Schemas bigger than one call
    details: >-
      A real system of record has hundreds of fields, and a provenance envelope multiplies them.
      Ribo partitions the target schema across calls, fills the gaps, and reassembles one result —
      because "pass your JSON schema to the API" stops working long before your schema does.
  - title: Provenance that is checked
    details: >-
      Every field arrives with a source quote, and Ribo verifies that quote actually appears in the
      source. An invented citation is detectable, not merely unlikely. That is a property a
      self-reported confidence score cannot have.
  - title: Human review is a contract
    details: >-
      Review is a stage in the pipeline, not a UI you write afterwards. Each leaf carries its own
      schema, so a review screen renders and validates itself — and nothing ships until every
      unverifiable field has been looked at.
  - title: Any source, one pipeline
    details: >-
      A PDF, an invoice, a report, a dictation — joined into a single session and extracted once.
      The half of the pipeline that produces text knows what a microphone is; the half that
      produces structured data does not.
---
