---
"@azx/ribo-cli": minor
---

`ribo schema init` reads a directory without `case.json` as one plain-folder sample named after the
directory: its `.pdf`, `.txt` and `.md` files are its inputs, ordered byte-wise by file name
(dotfiles skipped; any other extension, a subdirectory, an empty folder and a corpus root are
refused by name, the corpus root with the fix "pass its case folders"). A folder's PDFs get the
bare-PDF capture rule, and the command prints one stderr line per such sample stating the inferred
order — `inputs` in the scaffolded `case.json` is where to change it. A directory with `case.json`
behaves exactly as before.
