---
"@azx/ribo-core": minor
---

A session parked at `awaiting-review` can be re-extracted when a recording is added to it.

`reopenSessionForReview` took `done` or `dead`, and `closeSession` refuses anything but `open`. So a session sitting at the review gate had no move available — and a recording can be added to one: `enqueue` never looks at the session's status, and the relay transcribes the new recording regardless. The parked draft then covered fewer recordings than the session held, the reviewer opened it with the later clip missing, and nothing said so.

It now also accepts `awaiting-review`, **and only when the recording set has moved**. That condition is doing two jobs. It is what closes the gap; and it is what keeps re-parking an unchanged session an error rather than a silent success, which the cross-tab concurrency guarantee depends on — two tabs racing to rescue one session still settle as one winner and one refusal, because the loser reads an already-parked document with an unchanged set and is told so.

The refusal message names both halves of the condition — the status it found and whether the set had moved — since "nothing to re-park" is otherwise indistinguishable from "wrong status".
