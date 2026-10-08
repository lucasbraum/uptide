---
"uptide": patch
---

`check` compiles your code with the repository's own TypeScript (the `node_modules/typescript`
its build uses, found the way `fix` has found it since verification), and falls back to the
bundled compiler only when the repository installs none. Errors and their positions are the
ones your `tsc` would print: a repository on TypeScript 4.9 is no longer judged by TypeScript
6's rules. The coverage line says which compiler judged: `compiled 355 of 356 files in 5
workspaces with the repo's TypeScript 4.9.5`.
