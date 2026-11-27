---
"@azx/ribo-cli": minor
---

`ribo schema init` accepts a bare PDF as a sample: it loads as a one-input document sample named
after the file, with `pageCount` measured from the file through the same pdf.js path eval uses and
`capturedAt` stamped with the run instant (one per run) or an explicit `--captured-at <iso>`. An
encrypted or unreadable PDF is refused naming the file; a file with PDF magic bytes but no `.pdf`
extension is refused with a rename fix; with `--corpus`, one stderr line names the stamped files,
the instant and the flag. No file timestamp and no PDF metadata date is ever read, and a case
folder's declared capture block is passed through untouched.
