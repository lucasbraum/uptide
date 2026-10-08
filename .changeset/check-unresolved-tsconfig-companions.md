---
"uptide": patch
---

Two fixes to `check`:

- **A project whose tsconfig cannot be resolved is not compiled.** A tsconfig that `extends` a
  package or file that is not installed describes options the repository never builds with, so
  what a compiler reports there is not a place to change. `check` skips it, never turns its
  diagnostics into findings, and says so in the coverage line (a file governed by such a
  nested project is dropped from the workspace that happens to reach it):
  `compiled 5 of 7 files in 2 workspaces; not compiled: docs/tsconfig.json (extends "@tsconfig/docusaurus/tsconfig.json" cannot be resolved)`.
- **Companions move only when they have to, and by the smallest step.** A companion whose
  installed version already accepts the new target stays where it is. One whose peer range
  rejects it moves to the lowest release above the installed one that accepts the target (a
  release that pins the target exactly still wins), not the newest major the registry has.
