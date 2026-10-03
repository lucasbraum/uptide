---
"uptide": minor
---

`uptide check` opens with one screen: a row per dependency, a line per change rule saying
whether `fix` migrates it by rule, by agent or not at all, and the exact commands to run
next. Progress is a single live line that disappears; `--details` lists every site, reason
and compiler message, and `--verbose` now means one progress line per phase.
