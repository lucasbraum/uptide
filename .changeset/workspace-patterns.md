---
"uptide": patch
---

Workspaces are read from `pnpm-workspace.yaml` with a real YAML parser: the flow form
`packages: ['packages/*', 'apps/*']`, quotes, comments, `**` at any depth and `!` exclusions
such as `'!**/test/**'` now work, where before the flow form found no packages and Uptide
silently checked only the root. package.json `workspaces` is read as an array (npm, yarn) or
as `{ packages: [...] }` (yarn). A workspace file whose patterns match no package is now an
error that names the file and the patterns, instead of a check of the root alone.
