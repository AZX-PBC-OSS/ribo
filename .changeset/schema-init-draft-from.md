---
"@azx/ribo-cli": minor
---

`ribo schema init` gains repeatable `--draft-from <sample>`: name the samples the draft reads, by
loaded sample name and matched exactly as passed, while every passed sample still loads,
transcribes and scaffolds as a case — draft from a few representative samples, scaffold the whole
corpus in one command. Requires `--corpus`; a name matching no passed sample is refused before any
spend, as is an unreadable non-drafting sample (every sample loads and transcribes before the
estimate). Only drafting samples reach the prompt, the spend estimate and evidence validation, so
evidence can never cite a sample the model was not shown; an estimate above `--max-spend` that drafts
from more than one sample names
`--draft-from` as a fix alongside raising the ceiling. Without the flag, prompts, estimates and
output are unchanged.
