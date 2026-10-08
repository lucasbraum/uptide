---
"uptide": minor
---

What changed in `check`:

- **Breaking means confirmed.** A type-surface change is reported as breaking only when the
  compiler rejects your code against the target at that site, the runtime probe saw the
  export go, or a migration pack found it, in the verified tier as in the generic one. What
  nothing confirmed is listed as "possible impact", apart from the breaking count.
- **Coverage, under every package.** `compiled 355 of 356 files in 5 workspaces; skipped:
  <reason (count)>` says how much of the code that uses the package the compiler judged, and
  the verdict says "types partly verified" when not every file was.
- **TypeScript-version-aware defaults.** A repository on TypeScript 5 is read with
  TypeScript 5's defaults for what its tsconfig leaves unset (`strict` off, automatic
  `@types`), not the bundled TypeScript 6's. Monorepos compile far more of their files:
  workspace packages declared `workspace:*` under Yarn and npm resolve to their source,
  scoped programs keep the tsconfig's ambient declaration files, and a workspace that only
  peer-depends on a package finds the hoisted copy.
- **Companions.** `check` and `fix` move `@types/<pkg>` with `<pkg>`, and a package released
  in lockstep with it (react-dom with react): `check react` 18 → 19 moves react-dom,
  @types/react and @types/react-dom together.
- **One finding for a root cause that is one edit.** A compiler option (the global `JSX`
  namespace `@types/react` 19 removes, read by `"jsx": "preserve"`) and a repository
  parameter several call sites trip are each one finding at the place to edit, with the
  compiler errors as evidence.
