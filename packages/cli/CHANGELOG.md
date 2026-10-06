# uptide

## 0.4.0

### Minor Changes

- [#14](https://github.com/uptide-dev/uptide/pull/14) [`62b01d9`](https://github.com/uptide-dev/uptide/commit/62b01d9b911290ecb1e70426829ba79dbc32b116) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Uptide is now licensed under Apache-2.0

- [#3](https://github.com/uptide-dev/uptide/pull/3) [`bb2c00c`](https://github.com/uptide-dev/uptide/commit/bb2c00c635c5e79d95e52ee56a5ecd27def149b9) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Generic mode and support tiers.
  
  `uptide check` with no `--only` now analyzes every direct dependency that is behind, ranked
  by likely impact, within `--max-time` (default 60 s), and lists what it did not reach.
  Every dependency has a tier: `verified` (a migration pack) or `generic` (no pack: a finding
  is breaking only when the compiler or the runtime probe confirms it; the rest is in
  `--details`). One dependency failing no longer empties the report.
  
  `uptide fix --only <any dependency>` migrates a generic dependency with the agent under the
  same verification and publish gate, with `--max-cost` (default $1) and a pull request note
  that no pack covers the package. Without `ANTHROPIC_API_KEY` it says what it cannot do and
  changes nothing.
  
  `uptide plan` prints the order to upgrade in: target versions, peer-range constraints
  between packages and an effort estimate from the findings; also as JSON and HTML.

- [#34](https://github.com/uptide-dev/uptide/pull/34) [`089f7b9`](https://github.com/uptide-dev/uptide/commit/089f7b97177fd447e4dfe32cad6c77bb3e0224d0) Thanks [@lucasbraum](https://github.com/lucasbraum)! - `list` reads well on large monorepos: one row per package, two priority tiers, names never truncated.
  
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

- [#20](https://github.com/uptide-dev/uptide/pull/20) [`197a414`](https://github.com/uptide-dev/uptide/commit/197a4148797a0621ec1cd7a5130b56cb72e84628) Thanks [@lucasbraum](https://github.com/lucasbraum)! - `uptide list` opens with PRIORITIES: up to five rows, most urgent first, each with a one-line
  reason and the command to run. Signals are known advisories for the installed version (one
  request to npm's bulk advisory endpoint, public packages only; “advisories not checked” on
  failure), a deprecated installed version, a major line with no release in a year, a peer range
  holding another upgrade back and two or more majors behind; cheaper upgrades come first among
  equals. Runtime dependencies rank before dev-only ones (a dev package's advisory drops one
  severity step; dev rows say so), and an advisory row names its smallest fix, `fixed in 3.2.5
  (patch, same major)` or `needs 4.1.11 (major)`, ranks same-major fixes first and checks that
  version. `--no-advisories` (or `"advisories": false` in uptide.config.json) never sends the
  request. When nothing is urgent, it suggests the cheap batch. `Next` points to the top priority.
  Rules and weights: docs/priorities.md. No LLM calls.
  
  Groups: a scope is one family (`@radix-ui/*`) whatever versions its members are at, and
  packages group across scopes when a peer range of one's latest version needs the other or both
  pin the same exact dependency version (`ai + @ai-sdk/*`). Each group says why.
  
  The HTML report's tiles (Outdated, Major, Minor, Patch, Groups, Tooling, Priority, Verified,
  Possibly unused) filter the table, with the filter in the URL hash; each tile's count is the
  number of rows it shows. A Priorities block opens the report.

- [#5](https://github.com/uptide-dev/uptide/pull/5) [`f4a4674`](https://github.com/uptide-dev/uptide/commit/f4a467413b95f6e4e95bb826dbee8d9979db4e03) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Split fast dependency discovery (`uptide list`) from explicit analysis (`uptide check <package...>`). Check now requires package names and removes the implicit time budget. Plan uses discovery plus optional saved check results, with unknown effort until analyzed. Add positional fix names, memory-aware workspace scheduling, root-cause grouping and clear per-package recursion failures.
  
  Scope named checks and baseline compilation to importing files and their reachable dependencies. Calibrate memory estimates to that graph, use the full reservation for serial work, and retry parallel memory failures serially before skipping. Expand grouped root-cause locations only in detailed output.

- [#7](https://github.com/uptide-dev/uptide/pull/7) [`0dfed37`](https://github.com/uptide-dev/uptide/commit/0dfed37fed469b7ca3fecc2d2835edbffe977d55) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Support Anthropic, OpenAI and Gemini assisted fixes with provider/model selection, environment-only credentials, and a strict pre-call cost budget (default $1 per package). Keep the same patch verification and publish gate; add privacy-safe provider/model telemetry and documented model pricing.
  
  Select Sonnet 5.5 with medium effort after live storefront evaluation. Respect model-specific tool capabilities, retry rate limits within budget, and use Chat Completions for custom OpenAI-compatible endpoints.

- [#6](https://github.com/uptide-dev/uptide/pull/6) [`3820ca8`](https://github.com/uptide-dev/uptide/commit/3820ca83704b57b3f1a4ddf7ea86ef45ca499288) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Add anonymous telemetry with explicit opt-in, local on/off/status/show controls, CI opt-out, a strict privacy allowlist and best-effort PostHog EU capture configured at release time.

### Patch Changes

- [#32](https://github.com/uptide-dev/uptide/pull/32) [`36871e6`](https://github.com/uptide-dev/uptide/commit/36871e60b25a45f5028eb0417098f7f77652fa68) Thanks [@lucasbraum](https://github.com/lucasbraum)! - A package whose analysis fails no longer changes the results of the packages checked after it
  in the same run. A failure inside TypeScript's printer (a stack overflow, as `@types/node`
  20 → 22 caused before [#31](https://github.com/uptide-dev/uptide/issues/31)) left its partial output in the shared printer, and the next
  package's signatures silently began with it. Printing now recovers from a failed print, and
  after any package fails, `check` discards the shared TypeScript state (printer, the
  repository's program and checker, cached surfaces) before the next one.

- [#15](https://github.com/uptide-dev/uptide/pull/15) [`cbd7236`](https://github.com/uptide-dev/uptide/commit/cbd72365c468eb1f88da59a7321ec6aa164e4526) Thanks [@lucasbraum](https://github.com/lucasbraum)! - `uptide fix` migrates the commit you have checked out, cloned from your local repository,
  instead of the remote's default branch: a repository whose local branch was ahead of `origin`
  failed with "no package.json". A branch that differs from its upstream is said to in one line,
  uncommitted files are left out and listed, and `--pr` stops before any work when the base
  branch on `origin` does not contain your commit (`--base <branch>` names another base) or the
  working tree is dirty (`--allow-dirty`).

- [#9](https://github.com/uptide-dev/uptide/pull/9) [`d04d569`](https://github.com/uptide-dev/uptide/commit/d04d569e7e8f6e672574cc272440d9af6c7f82c9) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Honor npm INI parsing and registry/auth configuration precedence for dependency discovery,
  with host/path-scoped credentials kept out of output and persistent caches. Fetch abbreviated
  metadata with 16 concurrent requests, 10-second per-attempt timeouts and one retry on timeout/5xx.
  Stop calling a host only after 401/403/405. Keep unresolved packages counted as unknown,
  group repeated diagnostics by host/reason, and retain one incomplete HTML row per package.
  
  Recognize package.json tooling fields, installed bins, AngularJS/gulp/Karma and hook configs,
  stylesheet imports and HTML node_modules assets before flagging possibly unused dependencies.
  Keep that section collapsed with cautious wording and per-package reasons. Number HTML
  sections sequentially according to the sections present.
  
  Classify non-registry declarations and aliases as intentional skips, with collapsed terminal/HTML
  reasons and no error exit. Resolve npm registry aliases by their real package names, preserve
  local import usage, and read the correct pnpm/Yarn alias versions from lockfiles.
  
  Recognize tool rc files, hook/task commands, generic package configuration fields, Karma
  short names and auto-loaded plugins, colliding bins and required direct dependencies.
  Show the actual shared failure reason in discovery summaries. Add opt-in list --verbose
  phase timings and file counts, and preserve pnpm default/named catalog discovery.
  
  Preserve independently used group members' classifications and reasons. Read legacy lint-staged
  linters maps alongside flat configs, keeping ignore globs separate from commands. Prune vendored,
  generated and Git-ignored sources, prefilter with text/lexical gates before full parsing,
  and distribute large syntax batches across CPU workers. Report per-reason skip counts in verbose
  output while retaining complete group membership in JSON and check commands.
  
  Keep tool-specific ignores out of source discovery: formatting/linting scopes do not imply
  unused code. Warn in the summary, HTML, JSON and verbose output when Git rules exclude more
  than half of candidate application sources, naming the responsible patterns. Count Git-ignored
  sources from filenames only; retain usage under blanket prettier/eslint/lint-staged ignores.

- [#8](https://github.com/uptide-dev/uptide/pull/8) [`3815579`](https://github.com/uptide-dev/uptide/commit/381557937995a132b4cb39a38627e551ec8762cd) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Correct dependency discovery for NestJS and other script/config-driven projects: separate tooling and required peers from possibly unused packages, group lockstep and peer-coupled upgrades, count imported value references, hide zero-count symbols, show major-version gaps, and omit workspace columns in single-package repositories.
  
  Add `uptide list --html [--open]` using check's report template and styling, with group check commands, copy buttons and collapsed tooling/possibly-unused sections. Reports exclude source code and local paths by default; `--details` adds file lists. Add a synthetic single-package pnpm NestJS regression fixture.
  
  Add scope/lead-package group names and `check --group` expansion, peer member labels, width-aware terminal columns and details-only symbols. Share an offline light/dark report design between list and check with one command per group, responsive rows and private default output. Read the installed CLI version for report headers, including when a package is versioned after bundling.
  
  Count only visible upgrade groups in list summaries, reserve scope titles for the primary
  lockstep set, and use unique lead-package selectors for independent groups. Align terminal
  version arrows and show only target ranges in group headers. Keep standalone HTML copy
  actions in the package row with accessible command labels and manual-copy fallback.

- [#33](https://github.com/uptide-dev/uptide/pull/33) [`278ec5c`](https://github.com/uptide-dev/uptide/commit/278ec5c8edb63103c9195a5424660b5eb4822280) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Polish from a real run of `list` and `check`:
  
  - A group mixing families is named after its hub, the package joining them that is nobody's
    peer (`ai + @ai-sdk/*`, `--group ai`), even when a family member is used in more files. Its
    target names each major when they differ (`→ ai 7 · @ai-sdk/* 4`) instead of a range.
  - A group member's priority reads `<member> <reason>`, dev first: `dev · @eslint/js deprecated: …`.
  - `check` states every analyzed package's verdict and what verified it, zero included:
    `0 breaking · compiled against 4.6.5: 0 new type errors`, or `types not verified: <why>`; in
    the terminal, the HTML report and JSON (`verdict`, and `compile.newErrors`).
  - "by rule / by agent" reads "auto-fixable / need the agent (LLM)" in `check` and `plan`, and
    "auto-fixed / fixed by the agent (LLM)" in what `fix` did.
  - Every suggested command is written the same way, `npx uptide …` (`npx uptide@next` from a
    prerelease), `list` included.

- [#31](https://github.com/uptide-dev/uptide/pull/31) [`7790986`](https://github.com/uptide-dev/uptide/commit/77909861a539c60f23737cfac4e92e7e18e2fb6e) Thanks [@lucasbraum](https://github.com/lucasbraum)! - `check` no longer overflows the call stack on packages whose declarations refer back to
  themselves, such as pino 10's `declare namespace pino { export { pino as default, pino } }`
  ([#4](https://github.com/uptide-dev/uptide/issues/4)). Extraction emits a name that reaches a declaration it is already inside, and stops
  there, recorded as `recursive type pino (compared by name)`; walks nested deeper than 32
  levels are cut the same way. The diff compares through those cuts by what they stand for, so
  `pino.pino.stdTimeFunctions` is not reported as removed when `pino.pino` became `pino` itself.

- [#2](https://github.com/uptide-dev/uptide/pull/2) [`6d4d75a`](https://github.com/uptide-dev/uptide/commit/6d4d75aa00929c1139831d92bbb52cd2472b1057) Thanks [@lucasbraum](https://github.com/lucasbraum)! - New tagline, "Migrations you can merge.", in the CLI help and the package description.

- [#17](https://github.com/uptide-dev/uptide/pull/17) [`2bea992`](https://github.com/uptide-dev/uptide/commit/2bea992bfdceb69008800308d5301104a5e884a0) Thanks [@lucasbraum](https://github.com/lucasbraum)! - Workspaces are read from `pnpm-workspace.yaml` with a real YAML parser: the flow form
  `packages: ['packages/*', 'apps/*']`, quotes, comments, `**` at any depth and `!` exclusions
  such as `'!**/test/**'` now work, where before the flow form found no packages and Uptide
  silently checked only the root. package.json `workspaces` is read as an array (npm, yarn) or
  as `{ packages: [...] }` (yarn). A workspace file whose patterns match no package is now an
  error that names the file and the patterns, instead of a check of the root alone.

## 0.3.0

First public release.

- First public release: `npx uptide` shows where zod and stripe stand, `uptide check` lists
  the call sites an upgrade breaks, and `uptide fix` migrates them on a verified branch.
- `uptide check` opens with one screen: a row per dependency, a line per change rule saying
  whether `fix` migrates it by rule, by agent or not at all, and the exact commands to run
  next. Progress is a single live line that disappears; `--details` lists every site, reason
  and compiler message, and `--verbose` now means one progress line per phase.
- Commands printed by the CLI and written into PR descriptions name the build that printed
  them: `npx uptide` for a stable version, `npx uptide@next` for a `next` prerelease.
- stripe: a test fixture that was already cast straight to an SDK type (`{...} as
  Stripe.Subscription`) and stops compiling after the bump is widened by rule to
  `as unknown as`, and reported as "Test fixture casts widened"; a fixture with only the old
  subscription period fields gains the item that carries them. Casts the agent adds are still
  rejected. The `subscriptionPeriod` helper is placed by rule above the doc comment of the
  function that needs it when no shared client module is in reach.
  The Tests line adds workspaces up: "5 tests in 3 files passed".
- `fix --pr` and `pr-body` share one gate: a failed verification or a run from an Uptide
  checkout with uncommitted changes is never published, and the CLI says why. Tests are
  detected the same way everywhere (workspace script, the vitest or jest config covering the
  workspace scoped to related tests, root script) and the report says what ran. A PR body
  only contains what its own run found, and a stripe body says when no API change affects
  the code.
  `fix` formats the files it edited, and only those, with the repository's formatter, and runs
  the repository's lint on them; a new lint failure fails verification. `uptide verify`
  verifies a migration branch again where it stands, adding commits and never rewriting
  history. A failing test outside the affected files is rerun once. The zod pack finds what
  depends on zod 3's default error messages and fixes the test that fails on them; the stripe
  pack makes tests follow the pinned API version.
- A registry that rate limits (HTTP 429) or is briefly down is retried with backoff, and a
  dist-tag it answered before is taken from the local cache when it cannot answer now. When
  it still fails, `check` exits 2 and says so, instead of "not analyzed" with exit 0.
  Under `Node16`/`NodeNext` module resolution, `check` now finds usages of packages that ship
  separate declarations for `import` and `require` (stripe 22 and newer); they were reported
  as not imported.
- Verification no longer touches your services: tests that need a database, cache or queue
  are opt-in (`--with-services --yes`, after printing what they connect to), and by default
  only unit tests run, with the integration tests counted in the report.
  `fix` and `verify` work in a temporary clone, never in your checkout, with lifecycle scripts
  and git hooks disabled for every command they run; the checkout is compared before and
  after. `verify --push --yes` pushes new commits from the clone, fast-forward only.
  The temporary clone is removed when the run is over and kept, with its path printed, only
  when the run fails, with `--keep`, or when it holds commits that are nowhere else.
  `uptide clean` removes kept clones older than 7 days.
