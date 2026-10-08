---
"uptide": minor
---

`check` reports a type-surface change as breaking only when something confirms it at the
site, in every tier: the compiler rejects the code against the target, the runtime probe saw
the export go, or a migration pack found it. What nothing confirmed is "possible impact",
listed apart and never counted as breaking. Every analyzed package prints how much of the code
that uses it the compiler judged (`compiled 355 of 356 files in 5 workspaces; skipped: ...`),
and the verdict says "types partly verified" when not every file was. Monorepos compile far
more of their files: workspace packages declared `workspace:*` under Yarn and npm resolve to
their source, scoped programs keep the tsconfig's ambient declaration files, a workspace that
only peer-depends on a package finds the hoisted copy, and a repository on TypeScript 5 is
read with TypeScript 5's defaults (`strict`, automatic `@types`) rather than the bundled
TypeScript 6's. A root cause that is a compiler option is one finding at the option: the
global `JSX` namespace that `@types/react` 19 removes, read by `"jsx": "preserve"`, is
reported once at the tsconfig line with the element errors as evidence. `check` and `fix`
move `@types/<pkg>` with `<pkg>`, and a package released in lockstep with it (react-dom with
react): `check react` 18 → 19 moves react-dom, @types/react and @types/react-dom together.
