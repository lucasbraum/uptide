---
"uptide": minor
---

`list` reads well on large monorepos: one row per package, two priority tiers, names never truncated.

#### Breaking for JSON consumers

`uptide list --json` has **one entry per package** in `packages[]`, where it had one per
installed version. A package that workspaces install at different versions now carries them
all in a new field, and every other field describes the whole package:

- `versions`: `[{ "version", "workspaces" }]`, oldest first, every installed version
  (outdated or not). Absent when all workspaces agree.
- `current`: the oldest outdated version; `change`, `majorGap` and `tier` describe it.
- `workspaces`: every workspace on an outdated version (was: those on `current`).
- `usage` is counted once per package across the repository (it was repeated on each row).
- `signals.security` covers the advisories of any installed version; its `fixedIn` is the
  first clean version above all of them.
- New: `signals.drift` (`{ majors, workspaces }`) and `priorities[].tier`
  (`urgent` | `planning`); `priorities[].signal` can be `drift`.
- `packages.length` (and the `outdated` count) is the number of packages, no longer of
  package versions.

To read the old shape, expand each entry:
`p.versions?.filter((v) => v.version !== p.latest).map((v) => ({ ...p, current: v.version, workspaces: v.workspaces })) ?? [p]`.
`uptide plan` does exactly this, so it still plans each installed version.

#### Changes

- Workspaces on different versions share a row (`5.0.52, 7.0.59 → 7.0.128`), with
  `2 versions in 3 workspaces` in the last column (under the row when the terminal is too
  narrow). A new priority signal, version drift (different majors across workspaces), ranks
  below unsupported and above blocking.
- PRIORITIES has two tiers: **Urgent** (advisories, deprecations) with a count, then **Worth
  planning** collapsed to its count until `--all`.
- Names are never truncated: the name column fits the longest name (up to 45 characters, then
  the name gets its own line) and narrow terminals drop trailing columns instead.
- `major ×2` reads `2 majors behind` in `list` and `check`, terminal and HTML; JSON keeps
  `majorGap`.
- Compilers and bundlers (`typescript`, `@swc/core`, `esbuild`, `@babel/core`, `vite`,
  `webpack`) are tooling even when a script imports them, and a new major of one shows under
  TOOLING while it is collapsed: `compiler major: check build and tsconfig`.
- A group whose labels would repeat (`@supabase/* 2 · @supabase/* 0`) lists its target majors
  alone (`→ 2.x · 0.x`); a group heading keeps its target and puts the command under it when
  the line is too long.
