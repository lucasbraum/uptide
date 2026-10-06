---
"uptide": minor
---

`list` reads well on large monorepos:

- One row per package. Workspaces on different versions share it (`5.0.52, 7.0.59 → 7.0.128`,
  `2 versions in 3 workspaces`), and usage is counted once. JSON: `packages[].versions`;
  `current` is the oldest outdated version. A new priority signal, version drift (workspaces
  on different majors of one package), ranks below unsupported and above blocking.
- PRIORITIES has two tiers: **Urgent** (advisories, deprecations) with a count, then **Worth
  planning** collapsed to its count until `--all`. JSON: `priorities[].tier`.
- Names are never truncated: the name column fits the longest name (up to 45 characters, then
  the name gets its own line) and narrow terminals drop trailing columns instead. HTML never
  truncated.
- `major ×2` reads `2 majors behind` in `list` and `check`, terminal and HTML; JSON keeps
  `majorGap`.
- Compilers and bundlers (`typescript`, `@swc/core`, `esbuild`, `@babel/core`, `vite`,
  `webpack`) are tooling even when a script imports them, and a new major of one shows under
  TOOLING while it is collapsed: `compiler major: check build and tsconfig`.
- A group whose labels would repeat (`@supabase/* 2 · @supabase/* 0`) lists its target majors
  alone (`→ 2.x · 0.x`); a group heading keeps its target and puts the command under it when
  the line is too long.
