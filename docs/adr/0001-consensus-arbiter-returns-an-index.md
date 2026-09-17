# 0001. The consensus arbiter returns an index, not an envelope

Status: Accepted
Date: 2026-09-17

## Context

`consensusExtractor` hands each leaf's samples to a caller-supplied policy and uses what comes
back. The policy is caller-supplied, so the type has to answer a security-shaped question: can a
policy return something **no sample produced**? On a combinator whose output contract is "keeps a
citation", a policy that invents a citation is worse than one that invents a value.

The design originally specified a rank-2 signature — `<T>(input: { samples: readonly
Extracted<T>[] }) => { accept: Extracted<T> } | { contested: Extracted<T> }` — and claimed the
opaque `T` made fabrication a compile error. Checked against this repo's own compiler, it refuses
**one of three** cases:

| A policy returning                         | Compiles?                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| a fabricated literal value                 | no                                                                                     |
| `value: null`                              | **yes** — `Extracted<T>.value` is `T \| null`, so `null` is in the union for every `T` |
| a real value with an invented `sourceSpan` | **yes** — `sourceSpan` is `string \| null` and never mentions `T`                      |

The claim was two-thirds false, and false in the direction that mattered.

## Decision

The arbiter returns an **index into the samples it was handed**:

```
(input: { path: LeafPath; samples: readonly Extracted<unknown>[] })
  => { accept: number } | { contested: number }
```

The policy never constructs an `Extracted` at all, so whatever it names is provably one of the
envelopes it was given. On `contested`, the named index supplies the citation and the combinator
writes `value: null, confidence: 0` over it — the combinator does only what the policy provably
cannot.

## Consequences

Fabrication of a value, a confidence, or a citation all become impossible rather than one of the
three, and the rank-2 encoding disappears — `samples` can be plain `Extracted<unknown>[]`, because
a policy that compares and points has no need to name the value's type. Policies are markedly
easier to author.

The cost: one failure mode moves from compile time to runtime. A policy can name an index outside
the samples, so the combinator range-checks and **throws rather than clamping** — clamping to
sample 0 would reintroduce a fabrication and hide the policy bug permanently. That check is pinned
by test, on both verdict arms.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.1.
