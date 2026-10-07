---
"uptide": patch
---

`fix` verifies with the repository's own TypeScript (its `node_modules/typescript`, or an
ancestor's) or the bundled one, and never with a TypeScript that `NODE_PATH` or Node's global
folders happen to provide. A machine with a global TypeScript 6 made verification report
TS5107 deprecations the repository never sees.
