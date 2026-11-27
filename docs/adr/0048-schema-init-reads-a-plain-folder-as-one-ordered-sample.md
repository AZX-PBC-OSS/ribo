# 0048. Schema init reads a plain folder as one ordered sample

Status: Accepted
Date: 2026-11-27

## Context

After T1 gave `schema init` a case folder's ordered inputs and T2 let a bare PDF load as a
one-input document sample, a user whose job is three PDFs still had to invoke init three times —
one sample per PDF — and got one drafted case per PDF. Their material arrives one folder per job,
and the corpus the trial needs is one multi-input case per job. Before this decision, a directory
sample was always parsed as a declared case folder: without `case.json`, `parseCase` refused it as
unreadable, so the natural form of the material had no path into the tool.

## Decision

A directory without `case.json` is one sample, named after the directory. Its inputs are the
non-dotfile files directly inside it: `.pdf` is a document input (getting T2's capture rule —
measured page count, stamped `capturedAt`), `.txt` and `.md` are text inputs, and any other
extension is refused by name. Dotfiles are skipped; a subdirectory is refused; a link is refused rather than followed, so nothing outside the folder
is read; an empty folder is
refused; a directory holding `manifest.json` is refused as a corpus root, with the fix "pass its
case folders". The inputs are ordered **byte-wise by file name** — a comparison on the UTF-8 bytes
of the names, independent of locale and of the filesystem's listing order. That order is a stated
default, never a silent one: the command prints one stderr line per plain-folder sample stating the
inferred order, and the scaffolded `case.json`'s `inputs` list — which records exactly that order —
is where the user changes it. A directory that does hold `case.json` behaves exactly as after T1;
nothing about declared cases changes.

## Consequences

The path from "a folder per job" to "a runnable scaffold" is complete: one invocation takes the
whole folder, drafts over all of it, and scaffolds one multi-input case whose `case.json` the
author edits from there. Byte-wise order costs a user whose working order was the desktop's
listing order one look at stderr and one edit to `case.json` — cheap, compared with the silent
order-dependence of taking the listing as it comes, which would make a draft's evidence order
depend on whatever the filesystem happened to return.

The alternatives were rejected for the same reason in two shapes. A `--case name=files` flag would
move the grouping into a command line, where it is unwritable, unreviewable and unhittable with a
tab-completion; a folder is the grouping the user already made. Leaving grouping entirely to
hand-written `case.json` restores the refusal this decision removes: the trial user with three
PDFs would have to learn the corpus format before their first draft, which is the ordering of the
workflow backwards — init drafts the schema that makes the corpus worth writing.
