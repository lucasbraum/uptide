---
"uptide": patch
---

`uptide fix` migrates the commit you have checked out, cloned from your local repository,
instead of the remote's default branch: a repository whose local branch was ahead of `origin`
failed with "no package.json". A branch that differs from its upstream is said to in one line,
uncommitted files are left out and listed, and `--pr` stops before any work when the base
branch on `origin` does not contain your commit (`--base <branch>` names another base) or the
working tree is dirty (`--allow-dirty`).
