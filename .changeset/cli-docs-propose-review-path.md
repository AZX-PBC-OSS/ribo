---
"@azx/ribo-cli": patch
---

The handoff and the docs lead expected answers through propose and review (ADR 0049). `ribo schema
init`'s stderr handoff replaces "author them explicitly" with the expected-answers path — `ribo
corpus propose` (prefer a proposer that is not the model you will score) then `ribo corpus review`
— keeps prompt instructions on their own line as the author's to write, and conditions eval on
review; the command's help text and the root `--help` "Start here" line follow. The CLI overview
drops its command count, adds `corpus propose` and `corpus review` to the command table, adds
propose-and-review steps to both walkthroughs, and says to keep the drafted schema whole — a leaf
the reviewer cannot judge is rejected and stays unmentioned. The planning and corpus pages' "what
init scaffolds" passages now lead expected answers to propose and review while prompt instructions
stay author-written, and the author's-judgement sentence becomes "confirmed by the author before it
is scored". The README carries the same distinction.
