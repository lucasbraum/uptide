# Architecture

Milestone 1: the contract diff engine. Given an npm package and two versions, produce a
classified list of changes to its public API surface.

Decision records in `docs/decisions/`: [ts-morph over the compiler API](decisions/0001-ts-morph-over-compiler-api.md),
[never install the analyzed package](decisions/0002-no-npm-install.md),
[surface as cache unit](decisions/0003-surface-as-cache-unit.md),
[conservative rename detection](decisions/0004-conservative-rename-detection.md),
[no database in milestone 1](decisions/0005-no-database-in-m1.md),
[assignability over text](decisions/assignability-over-text.md),
[two signals and the compiler as arbiter](decisions/0006-two-signal-usage-analysis.md),
[direction at usage time](decisions/0007-direction-at-usage-time.md),
[lockfile as installed version](decisions/0008-lockfile-as-installed-version.md).

## Layout

- `packages/core` (`@uptide/core`): the engine. Language-agnostic except for
  `src/adapters/typescript/`. Everything else operates only on `ApiSurface` and `Change`.
- `packages/cli` (published as `uptide`, engine bundled in): thin shell over the engine. One command: `uptide diff`.
- `fixtures/`: real package pairs (`pairs.json`) and a hand-written synthetic package used
  by adapter tests. `corpus.json` lists public repositories, each at a pinned commit, that
  uptide is validated against by hand (what each one exercises, and with which command).

## Pipeline

```
fetchPackage(name, version)  -> PackageDir   npm tarball -> temp dir; never runs scripts
extractSurface(PackageDir)   -> ApiSurface   language adapter
rawDiff(A, B)                -> Change[]     compare by canonical path (textual); pure
compareTypes(A, B, paths)    -> relations    language adapter, type checker (optional)
refineWithTypes(changes)     -> Change[]     assignability verdicts replace textual ones; pure
classify(Change[])           -> Change[]     severity assigned; pure
```

`diffSurfaces(A, B)` is `rawDiff` + `classify`, still pure; `diffPackage` runs the full
chain. See `decisions/assignability-over-text.md`.

Every function is pure except fetch and filesystem I/O, which sit behind `PackageFetcher`
and `SurfaceCache` (`src/domain/io.ts`) so tests can stub them.

## Check pipeline (milestone 2)

```
loadRepo(cwd)                         -> RepoDir + installed versions (lockfile, never node_modules alone)
findUsages(repo, pkg, surface)        -> Usage[]      language adapter; EVERY usage, affected or not
diffPackage(pkg, installed, target)   -> Change[]     milestone 1
match(changes, usages)                -> Finding[]    core, language-agnostic: join, direction, fixability
report(findings)                      -> CheckReport  counts only; no time estimates
```

Two usage signals feed `match`. Signal A resolves imported symbols with the type checker
and follows them to every reference, mapped to canonical paths (below). Signal B compiles
the repo against the target version in a temporary overlay and turns diagnostics into
`via: 'inferred'` usages (step 5).

Signal A runs first and bounds the diff: only the used paths and their ancestors of the
*installed* surface are compared, plus every member of a container the consumer
`implement`s (the target side stays whole, so a removal can still be recognised as a move
and additions stay cheap). A class the consumer only constructs does not drag its members
in: ioredis's two thousand overloads cost five seconds of assignability checks for twenty
call sites. `uptide diff` keeps
the full comparison. A finding the compiler did not object to (see the arbiter in Signal
B) carries severity `info`: it is never listed, never counted, and only appears in the
"N low-confidence findings hidden" line.

### Release groups

Packages that version in lockstep are upgraded together (`src/check/groups.ts`):
dependencies of one scope, installed on the same major, connected by depending or
peer-depending on one another or on the same package of that scope (`@aws-sdk/client-s3`
and `@aws-sdk/s3-request-presigner` share `@aws-sdk/core`, which need not be a direct
dependency). `@aws-sdk/client-s3` alone at 3.1141.0 next to `@aws-sdk/core` at 3.1076.0
is a state no install produces, and the errors it compiles to are nobody's. A group runs
Signal A and the diff per member, one overlay with every target linked (group members are
never fetched as dependencies of one another), findings per member, and one report titled
`@aws-sdk/* (3 packages)` with `members` listed. A member with nothing to analyze leaves
the group.

### Companions

A package can also have to move with packages outside its scope (`src/check/companions.ts`).
`ai` and the `@ai-sdk/*` packages pin the same `@ai-sdk/provider`: `ai` 7 next to
`@ai-sdk/react` 3 is an install no real upgrade has, with two copies of the provider's
types. When `check` is asked about one package, the group is the one `list` draws
(`dependencyGroups`: family, peer link, shared pin) among the dependencies installed in its
workspaces, and each member moves to the version that agrees with the target: the version
the target pins exactly; else its newest release that pins or accepts the target; else its
newest release whose exact pins agree with the target's. The report is the lead's
(`ai (3 packages)`) with `companions` (name, from, to, why) and `companionConflicts` (a member
no release agrees with). `fix` installs them together: the version is resolved exactly first
and the range style restored after, so `^4.0.1` stays at the 4.0.1 the target pins; the
lockfile may change inside any of their subtrees and nowhere else. A conflict stops `fix`
before it writes anything.

Two links `list` does not draw are added for the plan. `@types/<pkg>` moves with `<pkg>` by
name (nothing in its manifest says so), to the release that types the target: the newest at
the target's major.minor, else at its major, else the newest there is, never below what is
installed (`src/check/types-release.ts`; `prepare` diffs the types package at that version).
A package whose release at the target's own version asks for the target (react-dom 19.0.0
peer-requires react ^19.0.0) is released in lockstep and moves to that version, even when the
installed copy's range would accept the target. The closure is transitive and companions can
move with companions: `@types/react-dom` with `react-dom`, which moves with `react`; a types
package waits for the package it types before its own manifest may place it. Every workspace's
dependencies are candidates, since a hoisting installer keeps the root's `@types/react` for the
app that declares `react`; a candidate must be visible from a workspace of the package it
follows (the same one, or an ancestor). `check react` 18 → 19 moves react-dom, @types/react
and @types/react-dom together; the plan is carried by every report of the package, alone or
leading its group, and the merged entry keeps every companion.

### One dependency, one decision

A dependency at the same installed version and target in several workspaces is one entry
(`mergeAcrossWorkspaces`): the call sites of every workspace under it, files prefixed with
the workspace path, counts summed, printed first under "(shared across workspaces)". A
dependency declared `catalog:` (pnpm catalogs, `pnpm-workspace.yaml`) is such an entry
even when one workspace uses it, marked `catalog`: the version is pinned once for the whole
repository, so the upgrade is one decision. Workspaces at different installed versions
stay separate entries, since they are separate decisions.

### Honest verdicts

A package with no finding is `safe` only when every site was analyzed. With sites the
analyzer could not follow (a `require(name)` with a computed specifier, a load whose
result flows into an argument or a return) the status is `partial` up to a fifth of the
sites and `unknown` above that; the report says "no impact in N analyzed sites · ⚠ M
sites not analyzed" or "? unknown", never a green check over sites nobody looked at.

### require() and import()

A literal `require('pkg')` / `import('pkg')` bound to a name, a pattern or an inline
member access is followed. Where the checker types the load (JavaScript under `allowJs`,
`import x = require()`), its resolution is used; where it cannot (`require` returning
`any` in a TypeScript file), members and calls are matched against the surface's names
with `via: require` (certainty 0.85). Usages carry `loader: require`.

Signal B checks JavaScript on both sides: the baseline and the overlay programs run with
`checkJs: true` whatever the repository's tsconfig says (sharing the ts-morph program's
files and resolutions, so the extra baseline costs binding and checking only), and JS
findings follow "compiler decides, diff explains" like TS ones. Only a `@ts-nocheck` file
is beyond the compiler; usages there carry `checked: false` and the diff's verdict is capped
at `unverified`, never breaking on its own. Module-format findings are load-time facts and
are exempt from both rules.

Both compile programs are built the same way: the baseline is an overlay too, linking the
installed copies (or the @types release the runtime should have). A plain program and an
overlay differ in more than the target, in which files they pull in and how JavaScript
infers, and that asymmetry alone produced dozens of "new" errors for a patch release.

Two disagreements between types and runtime are reported as `unverified`, never breaking:
a `require()` value the target's declarations no longer make callable while the target
still ships a CommonJS build (`export =` became a default export, which the CommonJS build
normally still assigns to `module.exports`), and compile errors against a target that
ships types the installed version lacks (real for a type-checked build, invisible to the
repository today).

Signal A opens only the files that can concern a package. A repository index is built once
per program (a raw walk: the packages each file loads through imports, re-exports,
`import =` and literal `require()`/`import()`; the positions of member-name identifiers;
computed load specifiers); a package's scan then visits the files that load it or a barrel
of it in full, and in other files only the identifiers whose name the surface declares.

### Module format

The declaration diff cannot see a package go ESM-only; the manifests can
(`src/check/module-format.ts`). `type`, `main`/`module`, the `exports` conditions and
`engines.node` of the installed and target versions are compared, and a `module-format`
change (path `.`) is emitted when the target stops supporting `require()`. The Node the
repository runs is read from the most binding source first (`FROM node:<v>` in a
Dockerfile, `.nvmrc`/`.node-version`/`.tool-versions`, the CI `node-version`, then
`engines.node`) and the source is named. A bare major (`node-version: 22`, `FROM node:22`,
`>=22`) means the latest release of that major, which has `require(esm)` for 20 and 22;
only an explicit older minor (22.11, 20.18) rules it out. When the Dockerfile builds on a
custom base image the production Node is unknown; the next source answers and the
finding says so. Without `require(esm)` (22.12+, or 20.19 to 20.x) every `require()` site
of the package breaks; with it, each site is judged by export shape: destructured or
accessed named exports work, calling or constructing the module itself breaks (the
namespace is not a function; a default export needs `.default`), members that live on the
default export break, and a target whose ESM graph awaits at top level cannot be required
at all. When Signal C loaded the target on the repository's Node, what `require()` really
returned decides instead of the declarations: a throw (`ERR_REQUIRE_ESM`,
`ERR_REQUIRE_ASYNC_MODULE`) breaks every site, a namespace breaks the sites that call or
construct it and those whose member is only on `default`, and a value that is still a
function breaks nothing. Unknown Node makes the sites `unverified`, and says so. An installed
version without declarations (joi 13, node-fetch 2) is not skipped: its load sites and its
manifests are analyzed, and the note names which version lacks declarations.

### Types via @types

A package whose declarations come from DefinitelyTyped is analyzed against `@types/<name>`:
the baseline is the @types release matching the INSTALLED runtime's major (express 4 is
compared from `@types/express` 4.x even when the repository has 5.x installed, which is
noted as a warning of its own), the target is the @types release of the target's major
(never below the baseline; the latest release when the major has none), the overlays link
them for the runtime specifier (a baseline overlay when the baseline differs from what is
installed), and findings are reported under the runtime package labeled "types via
@types/<name> a → b". Identical releases skip the compile: the compiler has nothing to
judge. The runtime manifests still feed the module-format check. A curated list of
runtime-only changes (`src/check/runtime-changes.ts`: express 5 routing syntax, `app.del`,
`req.param`, `res.send(status)`) is matched syntactically on the files that use the package
and reported as `unverified`, labeled "runtime change, not visible in types".

### Workspace dependencies compile from source

A `link:`/`workspace:` dependency is consumed through its built `dist/*.d.ts`, which is
whatever the last build left there: `packages/api` type-checked against a `shared/dist`
built on zod 3 reported thirty-five zod 4 errors that were not api's. The dependency's
`types`/`exports` targets under its `outDir` are rewritten under its `rootDir` (tsconfig),
or `dist/` to `src/` when there is no tsconfig, and offered to the compiler as `paths`
(`src/adapters/typescript/workspace-source.ts`) in the baseline, overlay and usage programs
alike. What cannot be mapped keeps the dist, with a warning under the workspace's packages
when that dist is older than the source it was built from.

### Workspaces

`workspacePackages(root)` reads `pnpm-workspace.yaml` (`packages:` globs, one level of
`dir/*`, `!` exclusions) or package.json `workspaces`; the root is a workspace too. Each
workspace is checked with its own tsconfig (and project references), its own lockfile
importer and its own `node_modules` resolution, in worker threads (`src/check/worker.ts`,
`workspaceConcurrency`, default 2: a parsed program is hundreds of MB, and the heaviest
workspaces are scheduled first). Inside a workspace the phases are CPU-bound on one thread,
so the per-package pool only overlaps registry and disk waits. Installed versions are read
from the lockfile without parsing sources, so listing a workspace costs nothing. When another workspace
declares the same dependency itself, its files are excluded from this workspace's usage
scan and compile (`RepoDir.exclude`), whether they are nested under it (the root's
`include`) or pulled in through a project reference; so a usage is reported once, under
the package that owns it. The summary counts a dependency once across workspaces.

A workspace may import a package it does not declare (a Next app reading `stripe` through
the core package that declares it, hoisted by `shamefully-hoist`). The lockfile would never
list it, so a text scan of each workspace's own sources (`src/check/importers.ts`:
`from 'pkg'`, `require('pkg')`, `import('pkg')`, nested workspaces excluded) runs once in
the main thread. An undeclared importer is analyzed against the copy it resolves to, with
`PackageReport.undeclared.via` naming the `workspace:` dependency that declares it; one
whose import does not resolve is a `skipped` entry with the reason. `PackageReport.importers`
lists every workspace that imports the package, declared or not, analyzed or not, so the
report never drops a workspace silently; the CLI prints the undeclared and the unanalyzed
ones under the package (`ui · imports stripe without declaring it (resolved via
@acme/core)`).

### Repo loading (TypeScript adapter, `src/adapters/typescript/repo.ts`)

The repository root is the nearest `package.json`. Installed versions come from the
lockfile (`src/adapters/typescript/lockfile.ts`: pnpm v5 and v6+, npm v1 and v2/v3, yarn
v1 and berry, bun's text lockfile), never from `node_modules` alone. The lockfile may sit at a
workspace root above the package being checked; the importer read is that package's
(`importers[<rel>]` for pnpm, `packages[<rel>/node_modules/<name>]` before the hoisted
entry for npm, the declared range's entry for yarn, the workspace's nested key for bun),
so two workspace packages on different versions of the same dependency are read correctly. A
dependency declared `workspace:`, `link:` or `file:` is recorded under that specifier whatever
the lockfile says for it (Yarn writes `0.0.0-use.local`, npm nothing), so the source mapping
below and the `workspace` status read it the same way under every manager. The
ts-morph project comes from the repo's `tsconfig.json` (its `paths`, `include`, and
project references one level down) or, without one, from `**/*.ts,tsx` minus
`node_modules`, `dist` and `build`. A scoped program (the files that use one package) also
holds the ambient `.d.ts` files the tsconfig includes (`vite-env.d.ts`, `css.d.ts`): nothing
imports them, and without them `*.module.css` imports and `declare global` names fail.
Nothing in the repository is executed, with one deliberate load: the repository's installed
`typescript` package (resolved from its `node_modules`, see the compile section) is loaded
into Uptide's process to compile with, as `verify` has done since #40; no script or other
code of the repository runs.

The compiler bundled with ts-morph is TypeScript 6, whose defaults for an option a tsconfig
leaves unset differ from TypeScript 5's: `strict` on, no automatic `@types` inclusion, a
modern `target`, `module` and resolution, `esModuleInterop` on. A repository on TypeScript 5
(or with none installed) is read with TypeScript 5's defaults made explicit
(`src/adapters/typescript/legacy-options.ts`: target ES5, module and resolution derived from
it, interop off, strict off, every `@types/*` package of the type roots), so a scoped program
reports what the repository's own compiler would; a repository on TypeScript 6 keeps the
compiler's own. A package's `main` pointing at a `.ts` source is not resolved from
`node_modules` by the bundled compiler either, which is one more reason workspace
dependencies are mapped to their source.

### Signal A (`src/adapters/typescript/usages.ts`)

The package directory is whatever the repo's own module resolution finds for the bare
specifier, followed through symlinks. The milestone 1 walker runs over it once more to
record `file:position -> canonical path` for every declaration it emitted; then every
identifier in the repo whose symbol (through import aliases) is declared inside that
directory becomes a `Usage`. This is why the paths had to be canonical: no name matching
happens here, the checker resolves `s.subscriptions.create` to the declarations and the
map turns them into `Stripe#subscriptions` and `create` on its type.

Two tiers keep this proportional to the package rather than the repository. A file that
imports the package, or a local barrel re-exporting it, has every identifier resolved. Any
other file can only meet the package through a value that flowed in from such a file, so
only member accesses (`x.parse`, `A.B`) whose name the surface declares and whose
receiver chain starts at an import binding are resolved, and an object-literal key is
resolved only when the literal visibly flows into the package (argument of a package
callable, or a declaration annotated with a package type). Resolving every identifier of
every file cost seconds per package on a 300-file workspace. A member name few symbols of
the surface carry (`current_period_end`, at most eight) is the exception: it is resolved
through the checker even when its receiver is not rooted at an import, so a value another
workspace's helper returned (`getStripe().subscriptions.retrieve()`) or a cast
(`event.data.object as Stripe.Subscription`) still counts. The price that remains is that
a common name on such a value (`const r = parse(); r.id`) is only a Signal B usage when it
breaks. In an importing file, a member read on an `any` receiver whose name exactly one
symbol of the surface carries is reported as that symbol with `via: 'inferred'`: the
compiler will never flag it, and the field may be gone at runtime.

In a type position the checker returns the resolved symbol rather than the alias (`z.infer`
comes back as `TypeOf`), so the name written at the reference is matched against the
surface as well: when it is an alias of the resolved path, the usage is recorded under it,
and a deprecation of `TypeOf` does not reach a consumer who wrote `infer`.

- `access` from the AST position: callee `call`, `new` `construct`, assignment target
  `write`, heritage clause `implement`, type position `typeRef`, import binding `import`,
  else `read`. Object-literal members are resolved through the literal's contextual type
  (through `| undefined` and unions), and count as `implement` when the value is a
  function, `write` otherwise. `new X()` maps to `X.new()` when the surface has one.
- `via`: `alias` for `import { z as zod }`, `reexport` when the alias chain passes through
  an export in a repo file (a barrel), `destructure` for bindings taken from a package
  value and every later use of that local, else `direct`.
- An import binding keeps the export name the consumer wrote (`makeClient`) as
  `symbolPath`, and its canonical target (`createClient`) as `canonicalPath`. Removing the
  alias name hits this consumer, and so does changing the target; `usagePaths(usage)` is
  what the join uses.
- `require('pkg')`, `import x = require('pkg')` and dynamic `import('pkg')` are not
  followed. They are returned as `unanalyzed: { file, line, kind }[]` and shown in the
  report, never silently dropped, even when the package itself cannot be resolved.
- `.js`/`.jsx` files are scanned exactly when the repo's tsconfig sets `allowJs`; the
  result says so in `includesJs`.
- The package directory is whatever the compiler resolves, followed through symlinks, so
  the pnpm store layout (`node_modules/.pnpm/<name>@<v>/node_modules/<name>`) and a
  `paths` mapping produce the same usages. The installed surface is extracted from that
  directory, never fetched: what is on disk is what the consumer compiles against.
- Qualifiers are not usages: `Parser` in `Parser.create()` is only the `create` usage.

### Signal B (`src/adapters/typescript/compile.ts`, merged by `src/check/merge.ts`)

The repository is type-checked twice: as it is, and with a second project whose module
resolution sends the analyzed package, and only it, to a temp overlay where
`node_modules/<pkg>` is a symlink to the target version's extracted tarball, so the
target's own `exports` map applies and every other import resolves as today. Only
diagnostics present in the overlay and absent from the baseline count, matched on file,
code and message (positions are not part of the key), so a repository with pre-existing
errors still gets the upgrade's errors; the count of pre-existing errors is reported as
one line. The overlay is skipped only when the baseline is structurally broken: an
invalid tsconfig, or more than half of the files unable to resolve their imports.

The target tarball has no `node_modules`. Its own imports must resolve to versions *it*
declares, not to whatever the consumer has (vitest@5 type-checked against the consumer's
@vitest/runner@4 produces errors that are not the consumer's). The overlay compile
reports every bare import it meets inside the target (and inside anything linked for it)
whose importer declares a range; the consumer's installed copy stands in when it
satisfies that range, otherwise the highest version inside the range is fetched from the
registry (an exact pin needs no version list) and linked next to the target, and the
compile runs again, up to five rounds (`src/adapters/typescript/target-deps.ts`,
ADR 0009). Packages in the importer's own scope (`@scope/*` for `@scope/x`, `@x/*` for
`x`) are always resolved this way: they release in lockstep. Only what the declarations
import is resolved, which is far less than a package's runtime graph. Linked and
unsatisfied dependencies are reported as notes. What nobody can serve stays unresolved,
is counted in `unresolvedInTarget`, and is shown as one warning ("N unresolved modules
inside pkg@ver, results may be incomplete"). Those never become findings: with
`skipLibCheck` an unresolved import inside a declaration file makes the type `any`,
which hides errors rather than inventing them.

The compiler is the repository's own (`src/adapters/typescript/compiler.ts`): the
`node_modules/typescript` in the workspace or the nearest ancestor that installs one, the way
its build and `fix`'s verification find it, never one from `NODE_PATH` or a global folder. Its
errors, at its positions, are the ones the repository's `tsc` prints; the newer bundled
compiler moves some (a JSX child's "not assignable to ReactNode" sits on the element's first
line in TypeScript 4.9 and on the child in 6) and judges by its own defaults. The bundled
compiler still parses the repository for Signal A (ts-morph is built on it), and when it is
also the one that judges (the repository installs none), the overlay shares the ts-morph
program. Otherwise a baseline program is built once per workspace with the repository's
compiler, from the ts-morph program's root files and the options that compiler reads from the
repository's tsconfig (an option a newer compiler dropped or defaults differently is the
repository's compiler's to read), with the same workspace-source `paths`; the overlay shares
that baseline instead. A workspace without a tsconfig of its own is configured by the nearest
one above it (a monorepo root whose `include` covers the workspace: excalidraw-app reads the
root's `jsx: react-jsx`), for its options only, never its file list; both programs read it,
and only a repository with no tsconfig anywhere gets synthetic defaults. The host's resolver is installed both ways the compilers ask
(`resolveModuleNameLiterals` from TypeScript 5, `resolveModuleNames` before it), and the cause
tracers take the compiler with the programs: node kinds and flags are its, not the bundled
one's. Which compiler judged is part of the coverage (`compilers`), and the coverage line names
it (`with the repo's TypeScript 4.9.5`, or `with the bundled TypeScript 6.0.2`; a monorepo
whose workspaces differ names each).

Every compile says what it covered (`CompileSignal.coverage`): the files it was asked about
(the package's usage files and the files importing them, per workspace) and how many it
type-checked, with a reason for each file it did not: outside the workspace's tsconfig, a
workspace whose baseline is structurally broken, an invalid tsconfig. Merged across
workspaces into `PackageReport.compile.coverage` (`compiled 355 of 356 files in 5
workspaces with the repo's TypeScript 4.9.5; skipped: ...`), it is printed under every analyzed package, and a package whose
files were not all compiled gets the verdict "types partly verified" with that line instead
of "compiled against <version>" (`src/check/verdict.ts`).

Cost is proportional to the package, not the repository. The overlay is a raw compiler
`Program` that shares the baseline's parsed and bound source files and its module
resolutions (only the target and its linked dependencies are parsed, once per compile);
its host canonicalizes paths exactly as the baseline's does, since `createProgram` rewrites
`file.path` on shared files. Only the files Signal A found usages in, plus the files
importing those, are type-checked, on both sides; a file that neither imports the package
nor imports a file that does cannot see a type of it change. Baseline diagnostics are
computed once per workspace and file.

Error diagnostics in repo files are then folded into Signal A: one that overlaps a known
usage confirms it (`compileError` on the usage, certainty unchanged), one whose message
names a package symbol the surface knows (`Property 'x' does not exist on type 'T'`,
`has no exported member 'x'`) becomes an `inferred` usage at 0.8, and the rest are
returned as unattributed compile errors the report lists as such. Timing is recorded for
the baseline and the overlay separately, and `compile: false` skips the signal; Signal A
alone still produces a complete report.

### Signal C (`src/runtime/runtime.ts`, `src/runtime/probe.ts`)

Types can say `export =` became a default export while `module.exports` is unchanged. In
a JavaScript repository that never type-checks, only loading tells. For every analyzed
package the installed copy and the target copy are each loaded with `require()` and
`import()` in a child Node, and the result is diffed: whether each load throws (and its
error code, `ERR_REQUIRE_ESM`, `ERR_REQUIRE_ASYNC_MODULE`), the export keys with their
`typeof`, whether the value and its `default` are callable or constructable. The changes
are `require-throws`, `import-throws`, `key-removed`, `callable-lost`,
`constructable-lost` and `namespace-instead` (a function became a namespace whose
`default` is the function).

The child is sandboxed: Node's permission model with read-only filesystem access (no
writes, no child processes, no workers, no native addons), a preload that makes every
socket connect and DNS lookup throw, a stripped environment and a 15 s timeout. Nothing is
installed and no install script ever runs. Node resolves through real paths, which pnpm's
nested `.pnpm` layout needs, so the installed copy is loaded from its real directory with
the `node_modules` beside it, where its own dependencies live. A copy outside the
consumer's tree (a fetched target or dependency) is copied into a temporary
`node_modules` instead of linked. The target copy does not see the consumer's packages by
name, since an older copy there would shadow the version it needs: its dependency tree is
resolved from the ranges it declares, using the consumer's copy when it satisfies the
range, the directories Signal B already linked, and otherwise the npm registry. Every
placed package brings its declared dependencies along, and a load that still fails on a
missing package asks for it at the range its importer declares and runs again. The
repository's Node version, resolved as for module-format findings, chooses a local install
of that major from nvm, volta, asdf or fnm; when none exists the current Node runs the
probe and the report says so.

A probe is inconclusive, not a change, when a copy looks native (`gypfile`, `binary`,
an `install` script, platform-specific optional dependencies), when a dependency could not
be provided at its declared range, when the sandbox denied something, or when neither
loader got a value. Results are cached per package@version and Node major under
`~/.cache/uptide/runtime`; `runtime: false` (`--no-runtime`) skips the signal. Curated
behaviour changes (express 5 routing) are not judged by the probe: they concern what a
call does, not whether it loads.

### Arbiter by file kind (`src/check/file-kind.ts`)

Signal B type-checks JavaScript with `checkJs` on both sides, but a repository that never
type-checks its JavaScript does not break when the declarations change. A usage carries
`checked: false` when the repository does not type-check its file: JavaScript without
`checkJs` or a `// @ts-check` pragma, or any file under `@ts-nocheck`
(`repoTypeChecks` in `domain/usage.ts`; usages the compiler inferred get the flag from
their file in `check.ts`). In such a file a finding stays breaking only when Signal C saw
a change the site hits: the load throws for the loader the site uses, a key the site
reads is gone from the exports, the module value the site calls is no longer callable
(or became a namespace whose `default` is the function), the value under `new` is no
longer constructable. Everything else the diff or the compiler claimed there becomes
`info` ("the compiler says this would not type-check but the repository does not
type-check this file, and the target loads with the same shape at runtime"), or
`unverified` when the probe did not run, was inconclusive, or the site uses a subpath
the probe never loads. Module-format findings are judged per site by `match.ts` instead.
In type-checked files the compiler stays the arbiter.

### Counting

A `module-format` finding stands for its file: switching a file to `import()` is one unit
of work however many lines `require()` the package, so `match.ts` keeps one finding per
file and verdict with every site in `Finding.sites`, and the report counts it once. A
removed re-export container (`core` in file-type 16, reached only through the alias
`core.FileTypeResult`, or written through the container itself) is no removal for a site
whose symbol still exists at the top level of the target (`targetPaths`). Release groups join scoped packages that depend on
one another explicitly whatever their majors (`@bull-board/express` 5 on
`@bull-board/api` 6), and same-major packages sharing a same-scope dependency.

### The plan: what `fix` will do (`src/fix/plan.ts`)

`check` attaches a `plan` to every package with findings worth acting on: the findings
grouped by migration rule, each group saying how many sites a rule takes, how many go to
the assisted fixer, and how many nobody automates. The split is not a guess from
`Finding.fixability`: it is a dry run of the pack's own `transform` over the same site list
`fix` works on (`selectedFindings` in `src/fix/select.ts`), with the same rule ids and
titles as the PR body (`changeRule`, `RULE_TITLES` in `src/fix/report.ts`). A site the
transform takes is "by rule"; any other site of an upgrade the pack supports is "by agent";
without a pack, or outside the versions it covers, the site is "manual". A rule marked
`perFile` in its pack (zod's `types`) is one edit per file, and compiler-only errors of that
file fold into it: "1 fix, 3 errors". Groups without a known rule get a plain-English
title; the raw compiler message stays in `detail` for `--details`. A pack can add one
line under a rule (`planContext` and `planNote`): stripe counts the API changelog entries
between the two pinned API versions that have evidence in the code, from the usages the
workspace had already scanned. `fix` runs its own check with `plan: false`.

The CLI renders the plan (`packages/cli/src/format-check.ts`): a header with the
repository and the elapsed time, one row per dependency, one line per rule, and a `Next`
block with the exact commands for the repository. `--details` keeps the full listing
(`format-check-details.ts`).

### Direction resolution

Milestone 1 defers some severities because it cannot see which side of the contract the
consumer is on. `match` resolves them from `Usage.access`; the result goes to
`Finding.severity`, and `Finding.reason` says why. Everything not listed keeps
`change.severity`.

| change kind | access | severity | reason |
| --- | --- | --- | --- |
| `widened` | `read`, `typeRef` (consumer consumes the value) | breaking | widened type is read by the consumer |
| `widened` | `write`, argument of a `call`/`construct` | additive | widened type only receives values from the consumer |
| `narrowed` | `read`, `typeRef` | additive | narrower value still satisfies the reader |
| `narrowed` | `write`, argument of a `call`/`construct` | breaking | consumer's values may no longer fit |
| `signature` (parameter widened/narrowed) | `implement` | inverted: widened parameter breaking, narrowed additive | consumer is on the other side of the contract |
| `signature` (parameter added optional / removed) | `implement` | additive / breaking | implementation may ignore extra arguments but must not expect missing ones |
| `removed`, `moved` | any, including usages of members | breaking | symbol or its container is gone |
| `deprecated` | any | deprecated | |
| `signature` (parameter became required / required parameter added) | `call`, `construct` | breaking | caller must now supply the argument |
| `signature` (parameter became required / required parameter added) | `implement` | additive | implementation now always receives the argument |
| `required` (property) | `write`, `construct` | breaking | consumer must now supply the member |
| `required` (property) | `implement` | breaking | implementation must now provide the member |
| `required` (property) | `read` | additive | the member is now always present |

The table is code: `resolveDirection` in `src/check/direction.ts`, one test per row.
When Signal B ran, the compiler arbitrates (`decisions/0006`): a diagnostic on a usage
makes its finding breaking; a breaking verdict resting on text comparison or a
widening/narrowing under 0.8 that the compiler did not object to becomes a possible
runtime change at confidence 0.3, hidden by default.
`match` in `src/check/match.ts` does the join:

- A usage answers to `usagePaths(usage)`: the name written and its canonical target.
  Both carry the same changes (the diff marks alias duplicates), so each change kind is
  reported once per usage, under the name the consumer wrote.
- A `removed` or `moved` change also reaches usages of the symbol's members; the reason
  says the container went away.
- An import binding is affected only by `removed`, `moved` and `renamed`: a signature
  change is reported at the call, not at the import line.
- Textual comparison (no type checker) also emits `widened` and `narrowed` kinds when it
  can tell the direction of a union change, so the table applies either way.

`check` requires an adapter with `findUsages` and throws `AdapterCapabilityError`
otherwise. It never substitutes an empty usage list, because an empty list renders as
"no impact on your code".

`confidence = change.confidence × USAGE_CERTAINTY[via]` (direct 1, alias and reexport
0.95, destructure 0.9, inferred 0.8). Findings under 0.5 stay in JSON and are hidden in
the human report unless `--all`.

### Changes reach a usage through the types it is declared with

A used symbol's signature names types (`StripeConfig#apiVersion` is declared as
`LatestApiVersion`). Those paths are part of the usage-first diff, and a change to one of
them (type, narrowed, widened, signature, removed) reaches every usage of the symbols
naming it, with the reason prefixed "`Stripe.LatestApiVersion`, the type of
`Stripe.StripeConfig#apiVersion`, …". One level only: what a used symbol is declared to be.
For this to see a value change, `typeof X` and `import('./lib.js').T` aliases print the
literals they resolve to.

### The compiler decides, the diff explains

When Signal B ran for the package and a usage has no new diagnostic, a breaking finding
of a compile-time kind (removed, moved, renamed, signature, required, type, narrowed)
becomes `info`: "diff says X but your code compiles against the target", confidence 0.3,
never listed, never counted. If the symbol's declaration file in the target has an
unresolved import, the compiler's silence proves nothing there and the finding is
`unverified` instead: shown in its own section, not counted as breaking. Deprecations are
untouched.

Breaking means confirmed, in every tier (`src/check/tier.ts`, `confirmBreaking`). A finding
stays breaking only with evidence: the compiler rejects the site, the runtime probe saw the
export go, a `require()` of an ESM-only target, the import of a name the target no longer
exports, or a migration pack found it in the code. A type-surface change the declaration
diff reports at a site nothing confirmed, in a file the compile did not reach as much as in
one it did, is `unverified`: the "possible impact" a report lists apart and never counts as
breaking. Packs keep their rules, and their breaking findings follow the same rule: a rule
claims the compiler-confirmed sites it matches, and a pack's own `detect` sites carry their
evidence. Without Signal B (`--no-compile`, or a skipped overlay) nothing is confirmed, every
surface change is possible impact, and the package carries the note "unverified: compile
check skipped".

A root cause can be a compiler option (`src/adapters/typescript/config-cause.ts`). The
target removes the global `JSX` namespace (@types/react 19); a workspace whose `jsx` is
`preserve` or `react` and names no `jsxImportSource` reads JSX element types from that
namespace, so every element in every file errors (TS7026, TS2602) with one fix. Those
diagnostics are anchored at the `jsx` line of the tsconfig that sets it (through `extends`),
as one `cause` finding marked `anchorOnly`: it counts as one site, the plan and `fix` list
the tsconfig, the diagnostics are its `downstream` evidence, and a pack rule claims the
anchor when it claims most of the errors under it (`ruleFor`). A `JSX.Element` written in
code is still a site of its own.

A root cause can be a repository parameter (`parameterCause` in `cause.ts`). A mismatch the
compiler reports at an argument (TS2345) or a JSX attribute (TS2322) whose parameter or prop
is declared in the repository with a type that names something from outside it
(`usePassThroughWheelEvents(ref: RefObject<HTMLElement>)`, rejected at eleven call sites once
the target's `useRef` returns `RefObject<HTMLElement | null>`) is anchored at the parameter,
`anchorOnly`, when at least two sites trip it: the one edit is the parameter's type, as the
migration guides say, and the call sites are evidence. The parameter may sit in another
workspace whose source the program maps (`packages/editor` for a call in `packages/tldraw`);
its path is the repository's. A parameter one site trips in a workspace is left to that site
there, carrying the parameter as a candidate (`sharedCause`). When the workspaces' reports are
merged (`mergeAcrossWorkspaces`, `check/shared-root.ts`), a lone site joins the anchor another
workspace already reports for the same declaration, and lone sites of two or more workspaces
make one anchor: one breaking finding at the declaration, `callSites` counting every workspace's
call sites, `downstream` listing them. A parameter only one site in the whole repository trips
stays that site's own finding. `pack test` scores the anchor at the declaration; the call sites
under it are evidence, neither true nor false positives.

A diagnostic confirms exactly one usage: the innermost whose span contains the
diagnostic's start. `z.string().trim().url()` is three usages on one line, and an error
under `url` says nothing about `trim`, whose finding goes through the arbiter like any
other. A confirmed usage with several known changes keeps the one that best explains the
error (highest confidence, then removed before signature before type) and drops the rest:
one diagnostic, one finding. A deprecation on a rejected line keeps its own severity; it
is not what broke the line.

Unattributed `unknown`/`any` diagnostics are traced to their root cause
(`src/adapters/typescript/cause.ts`): the expression at the diagnostic is followed to its
declaration, then through initializers, callees and receivers (a package callee such as
`schema.safeParse` hands over to its receiver; a member of a repo object type to its
receiver). A repo declaration on that chain is blamed only when its own type differs
between the installed version and the target, or when it fails to compile itself; the site
is never its own cause, and a declaration that compiles unchanged is not a cause whatever
flows through it. When such an unchanged declaration receives an `any` value, the value is
traced to its origin, an import or a declaration, and the origin is blamed. Diagnostics
sharing a cause collapse into one anchor finding of kind `cause` at the cause, with the
errors under it as `downstream` (`{ file, line, code, message }`, repository-relative):
"31 errors caused by `make` (file:line), whose type changed from `A` to `B`. Fix here
first." An anchor is not a call site: counts and section headers weigh it by its
downstream errors. Nothing traced means the diagnostic stays on its own.

A diagnostic new in the overlay that no known change explains is still a break by
definition. It becomes a finding of its own (`src/check/unattributed.ts`): severity
breaking, fixability unknown, reason "compile error not attributed to a known API change",
its change spelled `TS<code>` with the message's quoted identifiers normalized to `'_'`
as the grouping key; the report shows the first concrete message of each group verbatim,
truncated at 160 characters, with "(N similar)". When the message names a type
declared in a target file with unresolved imports, the finding is `unverified`.

Several symbols removed or moved at one site (a destructuring import of a package that
dropped them) are one finding listing the symbols.

Two joins are deliberately narrow. A removed or moved container yields one finding per
site, for the outermost removed ancestor: `sharp removed` once, not also
`sharp.ResizeOptions` and `sharp.ResizeOptions#width` on the same line. A deprecation
applies only to the name the consumer wrote: `z.infer` does not inherit `TypeOf`'s tag
through the alias join.

### Fixability

| finding | fixability |
| --- | --- |
| `moved`, or `removed` with a rename `replacement` | mechanical |
| `deprecated` whose JSDoc names a bare identifier or member as the replacement | mechanical |
| `signature` with only a parameter removed | mechanical |
| `required` parameter added, `type` incompatible, incompatible return | assisted |
| additive finding | none (nothing to change; counts in `callSitesChecked` only, not in `autoFixable`, hidden in the human report) |
| only seen through `via: 'inferred'` | unknown |
| everything else | manual |

## Fetching packages

`createNpmFetcher` (`src/fetch/`) implements `PackageFetcher`:

1. Resolve `name@version` (exact version or dist-tag; no ranges) through the registry's
   per-version manifest endpoint, falling back to the abbreviated packument for registries
   without it and to produce a useful "not found" error. The registry comes from
   `.npmrc` (user, then project, then `npm_config_*` environment), including
   `@scope:registry` and `_authToken` entries.
2. Download the tarball, verify its SRI integrity (or sha1 shasum on old registries), and
   cache it under `~/.cache/uptide/tarballs/<name>/<version>.tgz`. A cached tarball that
   fails verification is discarded and re-downloaded.
3. Extract into a fresh temp directory with a hand-written ustar/pax reader
   (`src/fetch/tar.ts`): regular files and directories only, `package/` prefix stripped,
   traversal rejected, symlinks and hardlinks skipped. Nothing is executed. Callers remove
   the directory with `removePackageDir`, which refuses paths outside the temp root.

Extracted surfaces are cached by `createFsSurfaceCache` (`src/cache/`) at
`~/.cache/uptide/surfaces/<adapter>/v<schema>/<name>/<version>.json`. `UPTIDE_CACHE_DIR`
and `XDG_CACHE_HOME` override the location.

## Domain model

`src/domain/` holds the types the whole engine speaks:

- `ApiSurface`: one package version, one adapter, a flat list of `ApiSymbol` sorted by path.
- `ApiSymbol`: a canonical `path`, a `kind`, a normalized `signature`, optional `optional`
  and `deprecated`, and `exportedFrom` (the entry points that reach it).
- `Change`: one difference between two surfaces, with `kind`, `severity`, `confidence`.
- `LanguageAdapter`: `extractSurface`, optional `compareTypes` (type-checker
  assignability), optional `findUsages(repo, pkg, surface)` returning every `Usage` of a
  package in a consumer repository.
- `Usage`, `Finding`, `PackageReport`, `CheckReport` (`src/domain/usage.ts`,
  `src/domain/report.ts`): milestone 2's output. A `Finding` is one change joined to one
  usage; its `severity` may differ from the change's once the direction of use is known.

`SURFACE_SCHEMA_VERSION` is part of every cache key. Bump it whenever extraction or path
rules change so a stale cached surface is never compared against a fresh one.

## Canonical symbol paths

The whole diff hinges on one property: **the same symbol in two versions produces the
same path when nothing about it changed**. Paths are therefore derived only from names
consumers use, never from file locations, declaration order, or which entry point happened
to export the symbol.

`src/domain/path.ts` is the only code that builds or splits paths.

### Grammar

```
path    ::= scope? segment ( '.' segment | '#' segment | '[]' )*
scope   ::= '"' module-specifier '"' ':'
segment ::= identifier | '"' escaped-name '"' | '()' | 'new()' | '[' key-type ']'
```

Examples:

| Path | Meaning |
| --- | --- |
| `parse` | top-level export `parse` |
| `Stripe.SubscriptionCreateParams` | type or static reachable as `Stripe.SubscriptionCreateParams` |
| `Stripe#subscriptions` | instance member `stripe.subscriptions` |
| `Parser.version` / `Parser#version` | static `Parser.version` and instance `parser.version`: same name, two symbols, never one path |
| `Stripe.SubscriptionCreateParams#items[]#quantity` | member `quantity` of the anonymous element type of `items` |
| `Headers#"content-type"` | member whose name is not an identifier |
| `Headers#[string]` | string index signature |
| `Parser#()` | call signature |
| `Parser.new()` | class constructor or construct signature (`new X()` is static-side usage) |
| `Color.Red` | enum member |
| `"express":Request#user` | augmentation of a foreign module |
| `"./server":Client` | subpath-only export whose name collides with a different root export |

### Rules

1. **Top-level segment is the export name.** A symbol's first segment is the name under
   which an entry point exports it. If one declaration is exported under two names
   (`export { foo as bar }`, `export * as ns`, a type re-exported under several
   namespaces), that is two symbols with the same signature: consumers import by name, and
   removing an alias breaks whoever used it. The longer ones carry `aliasOf` pointing at
   the shortest path, so counts can fold duplicates without losing any name.
2. **`export =` and `export default` of a nominal declaration use the declared name**
   (`Stripe`, not `default`): classes, functions, enums, interfaces, namespaces. A default
   export of a variable (`declare const _default: {…}; export default _default`, which is
   what the compiler emits for object defaults) uses `default`, since the variable's name is
   an artifact consumers never see. Members of an `export =` target are NOT also listed as
   flat top-level names, even though `esModuleInterop` lets consumers import them that way.
3. **Entry points are not part of the path.** They are recorded in `exportedFrom`. A
   symbol exported from `.` and `./v4` is one symbol. Moving it between subpaths while it
   stays reachable from the root changes nothing. (The exception is rule 8.)
4. **`.` joins static containment**: namespace members, static class members, enum members,
   types nested in namespaces. These are what consumers write as `Ns.Thing`.
5. **`#` joins instance containment**: class instance members and interface or object-type
   members. Classes may legally have a static and an instance member with the same name
   (Stripe's `errors` is one), and a namespace merged onto a class may add a third; `#`
   keeps them apart without depending on whether the sibling exists. This follows TSDoc
   declaration references.
6. **Anonymous object types are expanded under the property that carries them.** A property
   typed `{ quantity?: number }` gets a member `#prop#quantity`; an array of one gets
   `#prop[]#quantity`. Named types are never expanded through: `items: Item[]` yields
   `#items` with signature `Item[]`, and `Item`'s members live under `Item`. Type aliases
   whose body is an object type literal are expanded like interfaces.
7. **Containers do not carry their members in their signature.** A class's signature is
   its header (type parameters, `extends`, `implements`, `abstract`); an interface's is
   type parameters and `extends`; a namespace's is empty. Members are separate symbols.
   Merging a namespace onto a class therefore does not change the class symbol.
8. **Name collisions between different declarations** (a `Client` from `./client` and an
   unrelated `Client` from `./server`) are resolved by scoping the one not reachable from
   `.` with its entry point: `"./server":Client`. Foreign-module augmentations are always
   scoped: `"express":Request#user`. A symbol whose collision disappears would change
   path; this is accepted because the situation is rare and already confusing for consumers.
9. **Overloads are one symbol.** A function with three overloads has one path; the
   signature lists all overloads in declared order. Parameters are not symbols; their
   changes show up in the parent's signature.
10. **Non-identifier names are JSON-quoted** so `.`, `#`, `[` and `"` inside a name never
    split a path.
11. **Accessibility.** `private` and `#private` members are not part of the surface.
    `protected` members are included, marked in the signature, and carry
    `visibility: 'protected'`. A JSDoc `@internal` tag sets `visibility: 'internal'` on
    the symbol and everything beneath it. Both stay in the surface so nothing is lost;
    consumers of the surface (the eval script, the CLI) decide whether to show them.

### What is deliberately not in the path

- Type parameters, parameter names and types, return types: signature, not identity.
- Source file, declaration order, `export *` chains, `declare module` wrappers of the
  package's own name.
- Merged-declaration kind. `Stripe` as class + namespace is one symbol whose `kind` is the
  strongest of the merged kinds (class > function > variable > interface > enum > type >
  namespace > module). A type alias outranks a namespace because the alias is what
  consumers reference; the namespace is only a container.

## Signatures

A signature is normalized text produced by the TypeScript printer (canonical spacing, no
comments) with two transforms: union members sorted lexicographically, and
`import("./file").T` reduced to `T` so moving a file inside the package is not a change.
Nothing is expanded: a reference to `Item` stays `Item`.

Signatures never contain the symbol's own name. The name lives in the path, and a name in
the signature would make `export { createClient as makeClient }` look different from
`createClient` for no reason. Forms:

| Kind | Signature |
| --- | --- |
| function / method / constructor / call signature | `(input: string): Item; (input: Buffer): Item` (overloads in declared order; `protected` / `abstract` prefix) |
| property | `readonly ParseOptions`, `protected string`; `?` goes in `optional`, not here |
| accessor pair | property form; `readonly` when there is no setter |
| index signature | value type, e.g. `string \| undefined` |
| class | `class<T = Item> extends Base implements I` (`abstract` prefix) |
| interface | `interface<T> extends A, B` |
| type alias | `type<T> = 'a' \| 'b'`, or just `type<T>` when the body is an object literal (members are expanded) |
| enum / enum member | `enum` or `const enum`; members carry their computed value (`1`, `"custom"`) or `` when not computable |
| variable | `const string`, `let number`; `const {…}` when expanded |
| namespace / module | `namespace` / `module` |

An expanded anonymous object prints as `{…}` in its owner's signature.

## TypeScript adapter

`src/adapters/typescript/`:

- `entry-points.ts`: `exports` map first (subpaths; within a conditions object `types`,
  then `import`, then `default`, then the rest, so the ESM declarations win over a
  CommonJS `export =` twin), then `types` / `typings` / `main` / `index.d.ts` for the
  root. Without an `exports` map, top-level `foo.d.ts` files and top-level directories
  with their own `package.json` become `./foo` subpaths (next/navigation,
  expo-camera/legacy). Pattern subpaths (`./*`) and `typesVersions` are not handled yet.
  No types anywhere raises `NoTypesError`.
- `serialize.ts`: the printer pipeline above.
- `walk.ts`: exported declarations to symbols. `export =` is handled explicitly because
  ts-morph flattens its target's members into top-level exports. A namespace merged onto a
  class reports the class's statics as exports; they are filtered by parent so each member
  is emitted once. `declare module 'pkg'` blocks naming the package itself are walked as
  the entry point's exports; other ambient modules are foreign augmentations and get a scope.
- `index.ts`: one ts-morph project per package (Bundler resolution, no `@types` lookup),
  one walk per entry point, then a merge that resolves cross-entry collisions (rule 8).

Imports of packages that are not part of the tarball (dependencies) do not resolve, since
nothing is installed. Their names still appear in signatures as written; `export * from
'dep'` contributes nothing.

## Diff semantics

`diffSurfaces(A, B)` (`src/diff/diff.ts`) compares by canonical path, then `classify`
(`src/diff/classify.ts`) assigns severity. Both are pure.

Three rules make paths comparable across versions that restructure without changing the
API. **Apparent members**: a class or interface carries the members it has through
`extends` and intersections (the checker's properties of its declared type, statics
included), emitted under the derived path with the base's signature and file, so zod 4
declaring `ZodString#min` on a mixin does not diff as removed; only declarations inside
the package count, and the declaration itself stays mapped to the path it was declared
under. **Export shape**: `export = f` (a callable or class merged with a namespace) and
`export default f` plus named exports are the same thing to a consumer, so when the two
sides differ the `export =` root is looked up as the other side's default (`sharp` →
`default` or the same declared name), its namespace members as top-level names
(`sharp.ResizeOptions#width` → `ResizeOptions#width`), and `name.` qualifiers are dropped
from signatures before comparing. **Deterministic collisions**: when several entry points
export different declarations under one name, the root entry keeps the bare path and every
other entry is scoped (`"./pg-core":uuid`), decided over all entry points before paths are
assigned, so a new `./gel-core` cannot steal `./pg-core`'s bare `uuid` between versions and
`moved` means the symbol's own entry point stopped exporting it.

| Situation | kind | severity |
| --- | --- | --- |
| path in A, not in B | `removed` | breaking |
| path in B, not in A | `added` | additive |
| same path, declaration kind changed | `signature` | see below |
| same path, header/callable signature differs | `signature` | see below |
| same path, property/variable/alias type differs | `type` | see below |
| optional member became required | `required` | breaking |
| required member became optional | `type` | additive |
| newly `@deprecated` | `deprecated` (source `jsdoc`) | deprecated |
| deprecated in A, gone in B | `removed`, note "was deprecated" | breaking |
| path present in both, but B shares no entry point with A | `moved`, `replacement` is the new entry point | breaking (confidence 0.95) |
| same path, type checker says A is assignable to B only | `widened` | see below |
| same path, type checker says B is assignable to A only | `narrowed` | see below |
| same path, type checker says neither | `type` | breaking |
| same path, type checker says both ways | nothing | |
| moved between subpaths while still reachable from a shared entry | nothing | |

### Declaration kind changes

What consumers can do with a name is what matters, not the keyword. Interface to type
alias (either way) and method to callable property are additive at confidence 0.7 with a
note: call sites and type positions keep working, only declaration merging, `extends` and
`this` binding may differ. Class to variable is breaking at confidence 0.6: zod 4 replaces
classes with a value+type pair that still constructs but may not extend. Everything else
(a value becoming a type, a class becoming an alias) is breaking.

### Container headers

A class or interface header whose `extends`/`implements` list grew is additive at
confidence 0.8 (the new base's members are new API). A list that lost or swapped a member,
a changed type parameter list, or a class that became abstract is breaking. A class that
stopped being abstract is additive.

### Direction of a type change

With the type checker (`src/diff/refine.ts`, fed by the adapter's `compareTypes`):

| Role of the symbol | widened | narrowed |
| --- | --- | --- |
| callable parameter (function, method, call/construct signature) | additive, 0.8 | breaking |
| callable return | breaking | additive |
| callback parameter (function-typed property) | breaking | additive, 0.6 |
| callback return | additive | breaking |
| output (readonly property, variable, enum member, class) | breaking | additive |
| unknown direction (mutable property, type alias) | additive, 0.6, "breaking if read" | breaking, 0.7 |

Incompatible is breaking everywhere. A callable is compared parameter by parameter when
both sides have the same number of non-generic overloads; otherwise as whole function
types (new assignable to old is additive for callers).

Without the checker, signatures are parsed just enough (`src/diff/signature-parse.ts`) to
compare union member sets and callable parameter lists. Anything that fails to parse is
breaking.

- **Parameters are contravariant.** Widened type (confidence 0.8), new optional or rest
  parameter, or a parameter made optional: additive. Narrowed type, removed parameter,
  new required parameter, or a parameter made required: breaking.
- **Return types.** Narrowed: additive. Changed: breaking. Widened: additive at
  confidence 0.6 with the note "type widened; breaking if the member is read by the
  consumer"; milestone 2 promotes it to breaking when it finds a read.
- **Overloads.** Every old overload surviving verbatim: additive. One overload changed:
  compared as above. Otherwise breaking.
- **Type parameters.** A trailing type parameter with a default: additive. Anything else:
  breaking.
- **Properties and type aliases** are read and written by consumers, so no direction is
  safe for everyone. The project rule is that loosening is additive: a widened union is
  reported additive at confidence 0.6 with the same read caveat as returns; a narrowed
  one is breaking. `any` or `unknown` after anything counts as widened.

### Rename hints

A removed symbol and an added symbol with the same parent and kind mark the `removed`
change with `replacement` when the evidence is specific enough. The `added` change is left
alone and no `renamed` kind is ever emitted: a wrong rename would send a code modifier
down the wrong path, a hint only costs a reviewer a glance.

- **Leaves** (functions, methods, properties, variables, enum members) carry evidence in
  their signature: identical gives confidence 0.8, Dice ≥ 0.85 on the text gives 0.6.
- **Containers** do not: hundreds of Stripe interfaces share the header
  `interface extends EventBase`. They are matched on name similarity (≥ 0.5) plus Jaccard
  overlap of their members' names and signatures (≥ 0.5); both strong (≥ 0.6 and ≥ 0.8)
  gives 0.8, otherwise 0.6. An empty container needs name similarity ≥ 0.8.
- A hinted container passes its hint to members whose counterpart exists under the new
  name. Ties produce no hint.

### Genuinely public

The eval script and the CLI treat a breaking change as "genuinely public" when its symbol
has no `visibility` marker and its confidence is at least 0.7. Member changes implied by a
removed ancestor are folded into the ancestor, and a change on an alias is folded into the
same change on its canonical path. The full `Change[]` keeps everything;
milestone 2's usage finder needs member-level detail and the low-confidence cases.

### Known gaps

- Named types are never expanded, so an inline object type replaced by an equivalent named
  type is reported as a parameter type change at confidence 0.5.
- Without an `exports` map only top-level files and directories are treated as subpaths;
  deeper importable paths (`next/dist/...`) are not.
- Imports of dependencies do not resolve (nothing is installed), so a symbol whose type
  comes from a dependency prints as `any` and `export * from 'dep'` contributes nothing.

## Migration packs and verified edits

Generic `check` is frozen by ADR 0010. `MigrationPack` describes supported version
ranges, rules keyed by change kind and symbol, local transforms, checked-in guide
context, and review sections. Zod and Stripe implement the same boundary. The fix
runner owns filesystem writes, package-manager operations, git and verification.

`uptide fix` requires a clean pnpm repository root. It runs `check` first; only selected
reported sites (including structured downstream diagnostics, not cause anchors) are
editable. It creates the requested `uptide/<package>-<version>` branch, bumps every
workspace declaration/default or named catalog and installs with `--ignore-scripts`.
Version/lockfile, mechanical code, and individual accepted assisted edits are separate
commits. Tests and installation are explicitly authorized fix operations; `check`
remains read-only. Eval runs all writes in a temporary git worktree, with copied modules.

Verification creates fresh programs using the consumer's TypeScript and source mappings
for workspace imports, including referenced projects one level down. The tool compiler
is a fallback when no consumer compiler is installed. Diagnostics are subtracted as
multisets on file/code/message, ignoring shifted positions. Tests run before and after
with a time limit, chosen by one detection (`planTests` in `src/fix/verify.ts`): per
workspace its own `test` script; else the nearest vitest or jest configuration covering it
(its own or an ancestor's, as in a monorepo with one root config), run with the runner's
related-tests mode over the files with reported sites, or over the workspace directory
when none is known; else the root `test` script. Workspaces sharing a configuration share
one run. Each result records the command, how the scope was chosen, the workspaces it
answers for and the counts the runner printed; a workspace nothing covers, or a related
run that found no test, is reported as no tests, never as green. PASS requires zero new
diagnostics and no failing or timed-out target test run.

No `--pr` means no push. Opening a PR and updating one's description go through the same
gate (`publicationBlockers` in `src/fix/publish.ts`): a failed or pending verification, or
a run produced by an Uptide checkout with uncommitted changes, never reaches GitHub,
whatever `--yes` or `--no-llm` say; `fix --pr` refuses a dirty Uptide checkout before
doing any work. The report keeps why and the CLI prints it. The build stamps its commit and
whether the tree was clean, and git state is not something turbo can hash, so `build` is
never served from turbo's cache: a cached bundle would carry the stamp of whenever it was
first built. A stored run is scoped to
its repository, branch and commit: `pr-body` checks the run's recorded origin, branch
and verified head against the PR. The generated `.uptide/pr-body.md` is deliberately
uncommitted.

A failing test run is read before it is believed. A failure in a test that is not about
the affected files (a socket reset in an unrelated e2e test) is run once more and recorded
as a rerun; a failing test of an affected file is never retried into a pass. When the
migrated code makes a test fail for a behaviour change the pack knows and the compiler
cannot see, the pack proposes the edit (`testFollowUps`) and the tests run again, so the
repository's own suite decides whether it was right. Zod uses this for its default error
messages (`src/packs/zod/messages.ts`): zod 4 words them differently ("Required" became
"Invalid input: expected string, received undefined"), the behaviour probe only compares
custom messages, and the places that depend on the old text are found by scanning for the
known defaults in files that import zod and in test assertions. An assertion in a failing
test is updated where the new wording is certain; every other place is listed under
"Decisions for you" and left alone. Packs can also follow an accepted edit with edits no
diagnostic points at (`followUps`): stripe updates the assertion on the pinned constant and
makes other clients pinned by a repeated literal import that constant.

Nothing happens in the user's checkout (`src/fix/isolate.ts`). The CLI's `fix` and `verify`
work in a private clone: a clone and not a git worktree, because a worktree shares
`.git/hooks` and `.git/config` with the checkout it came from, which is how a hook installer
run by a `prepare` script once reached a real checkout. The clone pushes where the source
pushes, sees the same remote-tracking refs, commits as the same author, and gets the
installed dependencies as a copy (copy-on-write where the filesystem has it); `verify`
installs the migration branch's own lockfile there. Every install, build and test command
runs with lifecycle scripts off for npm, pnpm and yarn, hook installers told to stay out
(`SKIP_SIMPLE_GIT_HOOKS`, `HUSKY`, `LEFTHOOK`), pnpm's implicit install-before-run off, and
git pointed at an empty hooks directory (`quietEnv` in `src/fix/process.ts`); a `pretest`
build runs as a command of its own, never through the lifecycle hook. The checkout is
snapshotted before the run (HEAD, branch, `git status`, a digest of the hooks directory,
the local git config) and compared after it; a difference is reported, printed by the CLI
and blocks publication. What the checkout gains is a branch ref, when that needs no change
to the working tree (a new branch, or a fast-forward of one that is not checked out), and
the stored run inside `.git/uptide/<branch>/`, where `git status` never looks. A branch the
user has checked out is not moved: the commits stay in the clone, and `verify --push --yes`
pushes them from there, fast-forward only.

Clones live under one root of uptide's own (`<tmp>/uptide-runs/run-*`, each with a marker
file) and do not accumulate. A clone is removed as soon as it is no longer needed: the run
verified and its commits are somewhere else, pushed or a branch in the user's repository.
It is kept, and the report and the CLI say where and why, when the run failed (including
a run that threw), when `--keep` was passed, when the checkout changed during the run, or
when the clone is the only place the commits exist. `uptide clean` removes kept clones
older than seven days. Removal is guarded: only a directory directly inside that root,
named like a run and carrying the marker is ever deleted.

Tests that need services are opt-in (`src/fix/services.ts`). Before anything runs, the
runner configuration and the workspaces it covers are classified from their files alone:
integration and end-to-end tests by name or directory, and a global setup that connects
to a database, a cache or a queue (which runs, and may reset data, even for unit tests).
By default only what runs without services runs: for vitest through a generated
configuration that imports the repository's own, excludes those files, drops projects
that only hold them and removes a service-touching global setup; it is written for the
run and deleted after it. Where the setup cannot be taken out (jest, a vitest workspace
file) nothing runs. Either way the report counts the files that were not run and names what
they need. `--with-services` runs everything with the repository's configuration, and
only after the services and connection targets (credentials masked) were printed and
`--yes` confirmed them.

The repository's own style tools are part of verification (`src/fix/style.ts`). A tool is
used only when the repository configures it at its root and has it installed: biome,
prettier, eslint. After the edits, the formatter runs on the files the migration edited and
on nothing else, in a commit of its own; the lint then runs on those files, and a failure
that was not there on the same files before the migration fails verification like a type
error does. A pull request that breaks the consumer's lint is not a verified migration.

A migration branch that is already a pull request is never rebuilt: `uptide verify`
(`src/fix/reverify.ts`) runs the same closing steps (`settle` in `src/fix/settle.ts`:
format, related tests, test-driven follow-ups, type-check against the run's original
baseline, lint) where the branch stands, adds what is still to do as new commits on top,
and records the new HEAD in the stored run. History under reviewers is not rewritten, and
the gate is not bypassed: the description can be updated only after the new HEAD verified.

An API version bump whose changelog has no entry with evidence in the code and no breaking
entry is Medium risk ("billing path; API version bump with additive changes only"), and
its body says one thing throughout: what is left to check is outside the code.

Review material is scoped to the run as well. A pack's review sections receive the rule
ids of the run's own sites, so a decision about a rule appears only when the run has such
a site; the renderer derives what it says about a rule from the run's files and accepted
patches, never from names of a particular repository. For stripe the report also carries
the API changelog between the two pinned versions counted against the code's evidence
(`apiChanges`) and the `api_version` literals found in webhook payload fixtures, listed
as a decision because they mirror the endpoint's configured version.

Zod error-param transforms use syntax nodes and text-range edits rather than reprinting
the file. Literal messages become the requested input-sensitive callback. Nonliteral
messages are captured from the original options object, once, preserving evaluation
order alongside other options. Conflicting error maps, spreads and uncertain chains
remain manual. Deprecated formats require the flag and a direct imported-zod
`z.string()` receiver; later chain operations and arguments survive.

`Fixer` accepts a finding, local guide, enclosing function/declaration and compiler
error, and returns a single-file unified diff plus token usage. The Anthropic adapter
uses the Messages API directly (no SDK dependency), pinned to Sonnet 4.6; its standard
$3/$15 per million token rates are estimates, not invoices. Source outside that scoped
context is not sent. The full source is available locally to validate patch context.
Patches cannot rename/add another file or introduce diagnostic suppression. Each is
compiled alone and reverted unless its diagnostic disappears without new errors. There
are at most three attempts (two retries). No key means manual, with zero API calls.

Stripe has two concerns: SDK surface changes and API-version behaviour. API pins are
read statically from each SDK's declarations; releases within one major may pin different
API dates. Literal/LatestApiVersion and response/parameter findings are assisted/manual.
The maintenance script builds a versioned JSON snapshot of public changelog entries,
with source URL and SHA256. PRs list every stable-track entry between the API dates;
unknown target coverage blocks generation rather than implying a complete review.
Webhook endpoint API versions and other services' pins need review outside the code.

## Demo verification: zod and Stripe

Migration verification diagnoses each workspace implementation under its own tsconfig,
while using workspace sources to infer imports. Mixing api's bundler resolution with
shared's legacy node resolution produced an artificial Drizzle TS2307; the owning-config
regression now keeps that workspace's baseline at zero.

Assisted fixes use structured patch/explanation replies. Attempts retain diagnostics,
accepted/reverted status, tokens and estimated cost. Diff headers may be repaired only
when the old block matches uniquely and exactly; ambiguous or changed context is rejected.
Each accepted patch has its own commit. No remaining diagnostic after a prior accepted
edit is recorded as resolved by that edit, rather than generating another API call.

Zod's Behavior check compares declaration slices from the original source using zod/v3
with the migrated source using zod. Local declaration dependencies are included, but
application startup is not run. Other runtime imports are not fabricated: unsupported
imports and non-schema sites are explicitly skipped. A timeout-bounded child process has
no inherited credentials, no filesystem-write permission and blocked sockets. Seed 1729
produces up to 200 inputs/schema (valid, missing fields, wrong types, bounds, null,
undefined and extras). Bounded simple regexes are sampled; arbitrary refinements may have
no generated valid sample and are reported as a coverage limit. Success, cloned parsed
outputs, and custom error messages on touched paths are compared. Differences have
minimized examples and are review evidence, never a type-verification failure. This is
sampled evidence, not proof of behavioral equivalence or an OS security boundary.

Stripe's checked-in catalog includes resource/field/param/event tags inferred conservatively
from titles and URLs. The report matches Signal A paths plus handled event literals;
non-matches stay in a details block. Metadata can miss implicit changes, so that disclosure
remains available. API pins always require assisted review. Subscription period migrations
must document and guard a single-item assumption; mixed-period subscriptions need an
explicit product decision. Draft publication resolves the default branch, prints the remote,
branch, commits and diffstat, and requires --yes before any label creation or push.

### Schema-only behavioral import graph

Behavior verification follows relative imports (including `.js` specifiers pointing at
TypeScript) within the repository, selecting only schema bindings and their declaration
 dependencies. Unrelated statements never enter the child process. External runtime
imports, application helpers/constructors, unresolved imports, and repository escapes
are skipped with a reason. This is deliberately a conservative schema loader, not an
application-module loader. A bounded, secret-free child runs each v3/v4 pair.

The fixed-seed corpus first derives up to 24 distinct valid samples from formats,
constraints, enums, nested objects and arrays, then fills the 200-input budget with
invalid/boundary cases. Fewer than 20 valid inputs is disclosed (finite enums and
literal-only shapes cannot always supply 20 distinct values). Missing and wrong-type
custom messages are also asserted separately for every touched site/path; absent
custom messages are explicitly marked, not counted as successful assertions.

### Stripe evidence and period decisions

Changelog relevance requires a called method, a read/written member, a supplied
parameter, or a handled event, with a repository-relative file and line. Resource-name
overlap is insufficient. Explicit method mappings can be added to checked-in metadata;
unmapped entries stay in the complete collapsed disclosure. Period-field metadata is
attached to the actual subscription-period migration, not every title mentioning a period.
Each field-site prompt receives only its evidenced entries; an API-version pin receives
the evidenced entries for the repository because that pin changes all its requests.

The period guide covers `current_period_start` and `current_period_end` with one helper
(`PERIOD_HELPER`): the item that ends last, start and end from that same item, so the two
never come from different items; `undefined` on an empty list, which Stripe never returns,
and no sentinel timestamp anywhere (the validator refuses `?? 0`). Each site says what
`undefined` means where it stands: a webhook keeps its path of fetching the full
subscription, an API route throws "subscription has no items", the one new throw allowed.
The helper is placed once, by rule, in the module that creates the Stripe client in a
workspace every site workspace depends on (`sharedHelpers`), its name added to barrels
that export by name, and the agent imports it (`context.helpers`); a local copy is
refused. It preserves single-item values; the PR's “Decisions for you” explains
multi-item semantics and pagination limits. Accepted patches may not add throw/null nodes. Compilation
alone cannot prove business equivalence: this decision remains visible for human review.

### Bot PR action transaction

The composite Action executes trusted Uptide code separately from PR-head source.
It accepts only same-repository Renovate/Dependabot PR events and compares exact
lockfile importer versions, including pnpm catalogs. Read/check work uses PR-head
source with base dependency declarations, not stale base source. Each migration runs
in its own temporary worktree; only source diffs are applied to an exact PR-head
worktree. The head's original lockfile is verified again with type checking and tests.
Manual findings or failed verification abort the whole push. All successful package
patches become one commit whose parent must be the event's head SHA. The API head is
rechecked immediately before a normal, non-force push, so concurrent updates cannot
be overwritten. The sticky comment is updated through GitHub REST. Hosted credentials
remain in the orchestrator, not consumer install/test processes or git configuration.
The action uses the same migration adapters; its complete bot-PR simulation currently exercises pnpm. Unsupported managers fail explicitly.

### Package-manager migration transaction

`fix/managers` selects npm lockfile v2/v3, pnpm, Yarn classic, or Yarn Berry from
lockfiles and configuration, and checks the installed binary against `packageManager`
before edits. Exact, caret and tilde ranges retain their style in every declaring
workspace; pnpm catalog declarations remain catalog references. Other range forms
fail explicitly. Yarn Berry requires the node-modules linker.

An install runs in a detached temporary worktree with lifecycle/build scripts disabled.
The manager first resolves the requested target and then reconciles the final manifest
ranges. A graph comparison allows only the target and its before/after dependency
subtree to change; all other records and importer declarations must remain identical.
Only target declarations are excluded from importer comparison, including npm v2's
workspace compatibility records and pnpm catalogs. Generated Yarn/pnpm block mappings
are parsed conservatively without an added YAML dependency; unsupported syntax fails
closed. The lockfile is never rewritten by the parser.

A frozen/immutable install must leave the validated lockfile byte-identical. Only then
are those bytes and the resulting node_modules promoted to the migration branch.
Stale child installations are removed when the new graph hoists dependencies. Failed
installs preserve the original lockfile and installed dependencies. Type-checking and
workspace tests use the promoted graph; the version commit contains the manager's
actual output. Smoke tests trap lifecycle scripts and test zod rules plus a compatible
Stripe 14 → 22 upgrade, separately from Stripe changes requiring assisted decisions.
