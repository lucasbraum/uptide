---
"uptide": minor
---

Two fixes to `check`:

- **A project whose tsconfig cannot be resolved is not compiled.** A tsconfig that `extends` a
  package or file that is not installed describes options the repository never builds with, so
  what a compiler reports there is not a place to change. `check` skips it, never turns its
  diagnostics into findings, and says so in the coverage line (a file governed by such a
  nested project is dropped from the workspace that happens to reach it):
  `compiled 5 of 7 files in 2 workspaces; not compiled: docs/tsconfig.json (extends "@tsconfig/docusaurus/tsconfig.json" cannot be resolved)`.
- **A package that only peers on the package is left in place when its peer range rejects the
  target.** What always moves with the package stays as before: the release group published at
  the target's own version (`react-dom`), `@types/*`, the exact pins of the target, and the
  packages a pack names in `companions` (each with the official page that says so), even when their installed range already accepts the
  target. Any other package whose installed peer range rejects the target is not moved and not
  compiled at another version; `check` lists it under possible impact, never as breaking:
  `? possible impact, peer conflict: next-mdx-remote-client 1.1.2 declares react >= 18.3.0 < 19.0.0`.
