# CLI reference

`uptide --help` and `uptide <command> --help` are the authority; this page adds what help
cannot show.

## `uptide list`

Fast discovery with no compile, install, tarball downloads or execution of repository code.
Requires a lockfile (exact manifest versions also work once the repository is detected).
Shows every outdated direct dependency once, current → latest, major/minor/patch (including
`2 majors behind` for 10 → 12), verified/generic tier, importing files, calls and references,
and nonzero top symbols. Workspaces on different versions share one row
(`5.0.52, 7.0.59 → 7.0.128`, past two versions the oldest and newest), its last column saying
`2 versions in 3 workspaces` (under the row when the terminal is too narrow), and usage is
counted once across the repository. Workspace columns appear only in workspace repositories.
PRIORITIES come first, in two tiers, each row with a one-line reason and the command to run.
**Urgent** (up to five rows, all with `--all`): known advisories for the installed version,
with its smallest fix (`fixed in 3.2.5 (patch, same major)`, `needs 4.1.11 (major)`), and a
deprecated version. **Worth planning**, collapsed to its count until `--all`: a major line with
no release in a year, version drift (workspaces on different majors of one package), a peer
range holding another upgrade back, two or more majors behind. Runtime dependencies rank before dev-only ones (`dev · ` in the reason).
Rules and weights: [priorities.md](priorities.md). When nothing is urgent, it suggests a cheap
batch of minor/patch upgrades.
Groups follow: a scope is one family (`@radix-ui/*`) whatever its members' versions, and
packages group across scopes when a peer range of one's latest version needs the other or both
pin the same exact dependency version (`ai + @ai-sdk/*`); each group says why. Names use
the family or lead package; external peers are labeled `peer of <package>`.
`uptide check --group nestjs` discovers and expands the exact member list before checking.
JSON retains each member, the stable group selector and peer relationships.
`--json` has one entry per package: `versions` lists every installed version with its
workspaces when they differ, `current` is the oldest outdated one, and `usage` is counted once.
Other rows put majors first, then importing files and call sites. Terminal rows align to
the available width; names are never truncated (a name past 45 characters gets its own line)
and narrow terminals omit trailing columns instead. Top symbols
are hidden until `--details`. Only verified packages have a tier tag; generic is the default.
Color is disabled for pipes, `NO_COLOR`, `--no-color` and CI.

- `--all`: expand minor/patch rows, tooling and possibly unused packages.
- `--json`: every row, group, classification reason and discovery failure.
- `--html [path]`: write a local HTML report with check's template, styling and copy buttons.
  By default it lives beside check reports in the OS temporary `uptide` directory; its path
  is printed to stderr. Nothing is generated without this flag. JSON stdout stays pure.
- `--open`: with `--html`, open the page in an interactive terminal (never in CI or a pipe).
- `--details`: include top symbols and source file lists. HTML includes no source code, file paths, or
  workspace paths by default; commands without `--details` should be run from the named repo.
- `--no-advisories`: never send installed versions to npm's advisory endpoint; the PRIORITIES
  heading says “advisories not checked”. `"advisories": false` in `uptide.config.json` does the
  same for everyone in the repository.
- `--cwd <dir>`, `--ci`, `--no-color`: shared options.

Tooling is separate and collapsed: script commands and package bins, known build/config
tools, packages referenced in configuration, types for used runtime packages (and Node),
and peers of used packages. Compilers and bundlers (`typescript`, `@swc/core`, `esbuild`,
`@babel/core`, `vite`, `webpack`) are tooling even when a script imports them, and a new major
of one is shown under TOOLING even while it is collapsed (`compiler major: check build and
tsconfig`). Only the remaining packages without source imports are
“possibly unused.” Configuration is read as data, never executed; local installed metadata
is preferred for bins and peers, with registry metadata as a fallback.

Syntax scanning includes imports, re-exports, require, import-equals, literal dynamic
imports and JS/TS/JSX/TSX. Calls/new/JSX and non-call references are separate counts;
passing a binding as a value, such as `app.register(cookie)`, counts as a reference.
Indirect aliases and reflection are not followed. Counts are repository-wide, once per package, when several
workspaces lock different versions. HTML shows all upgrade rows, with tooling and
possibly unused packages in collapsed sections, and a copyable check command per row.
Internal workspace dependencies and local/git/URL specifiers are excluded from registry queries.

## `uptide check <package...>`

Examples: `uptide check zod`, `uptide check zod stripe`, `uptide check --group nestjs`. No names or group prints a short pointer to
`uptide list` and exits 2, before reading or analyzing a repository. There is no automatic
whole-repository budgeted mode or `--max-time` flag.

| Flag | Meaning |
| --- | --- |
| `--group nestjs` | discover the named release group and check all members, including required peers |
| `--only zod,stripe` | compatibility alias for positional package names; `all` is rejected |
| `--target zod@4.6.5` | exact target, repeatable; bare version with one selected package |
| `--details` | every site, reason, compiler message and analysis note |
| `--verbose` | one progress line per analysis phase, with timings |
| `--workspaces <n>` | maximum parallel workspaces, capped by memory and CPUs |
| `--cwd <dir>` | repository to work on |
| `--json` | the full report as JSON on stdout |
| `--ci` | plain log output: no color, no spinner (`NO_COLOR` is respected too) |

Exit codes: **0** no breaking changes, **1** breaking changes found, **2** bad arguments
or incomplete analysis. A failing package/workspace does not erase successful results.

### Tiers

Every row says `verified` or `generic`. Verified: a migration pack covers the upgrade, and
its ground truth from at least two public repositories has no false positive among breaking
findings ([docs/packs.md](packs.md)). A pack that has not met that bar yet is a candidate and
the row says generic. Generic: no verified pack. In both tiers a finding is breaking only
with evidence, which `--details` names under each site:

- your code does not compile against the target at that site;
- the runtime probe loaded the target and the export is gone or changed;
- a `require()` of a package whose target is ESM-only;
- the import of a name the target no longer exports;
- a migration pack found it in the code (verified tier).

Everything else the declaration diff suggests is possible impact: the row counts it apart
(`✗ 3 breaking, 17 possible`), the package lists it under "possible impact: N sites in M
files, not confirmed by the compiler or the runtime probe", and `--details` has every site.
It is never counted as breaking.

### Coverage

Under every analyzed package, one line says how much of the code that uses it the compiler
judged, and with which compiler: `compiled 355 of 356 files in 5 workspaces with the repo's
TypeScript 4.9.5; skipped: most files cannot resolve their imports at the installed version
(1)`. The compiler is the repository's own `node_modules/typescript` (the one its build runs,
so the errors and their lines are the ones `tsc` would print); only a repository that installs
none is judged by the bundled one, and the line says so (`with the bundled TypeScript 6.0.2`).
The files are the ones that import the package and the ones importing those, per workspace,
each compiled under its own tsconfig; a skipped one says why (not in the workspace tsconfig,
a workspace whose baseline cannot resolve its imports, an invalid tsconfig). When not every file was compiled, the verdict says `types
partly verified: compiled N of M files ...` instead of `compiled against <version>`: a clean
result only covers what was compiled.

A root cause that is a compiler option is one site. When the target drops the global `JSX`
namespace and the workspace's `"jsx": "preserve"` (or `"react"`) reads JSX element types
from it, every element in every file errors with one fix: `check` reports one finding at the
`jsx` line of the tsconfig that sets it (`"jsxImportSource": "react"` resolves it), with the
diagnostics as evidence, and `--details` shows a few of them. A repository parameter that
several call sites trip over (a hook typed `RefObject<HTMLElement>` once `useRef` returns
`RefObject<HTMLElement | null>`) is reported the same way: one finding at the parameter, with
the call sites as evidence, and `--details` prints `N call sites in M workspaces` under it
with a few of them. The call sites may sit in other workspaces than the parameter (a hook in
`packages/editor` called from `apps/examples` and `packages/tldraw`): a site alone in its
workspace still folds into the one finding at the declaration once the workspaces are merged.
The HTML report lists the call sites, with their workspaces, under the anchor; the JSON report
carries them as the finding's `downstream`, and `root` on each call-site finding names the
declaration it traces to.

### Partial results

A dependency whose analysis fails (the registry refuses, a tarball cannot be fetched, a
workspace runs out of memory) is listed under "Not analyzed" with the reason, and the
others are reported as usual. CPU count and available memory choose concurrency. About
60% of available physical memory (including OS-reported reclaimable memory) is reserved for
worker heaps plus native overhead. Only workspaces importing the named packages load programs.
Both baseline and target start from those importers, following their imports with the repository's
compiler options. The estimate counts reachable sources/declarations and importer roots, not all
installed declarations. If parallel execution does not fit, workspaces run serially with the full
reservation. An unexpected parallel memory failure is retried serially after other workers finish.
Only a scoped program that cannot fit alone is skipped, naming the workspace, estimate and available
memory. Partial or failed analysis is never called clean. `UPTIDE_WORKER_HEAP_MB` can
lower the limit, but cannot override the memory budget. Unexpected allocation failures
remain isolated to the workspace. Recursion failures name the package and give no safety verdict.

Common causes are grouped into one finding with a site count; `--details` expands sites.
For example, TypeScript 7 missing compiler API members form one cause rather than dozens.

While it runs, a terminal shows one live line with the current phase, which disappears
when the work ends; `--verbose` keeps one line per phase with timings. In a pipe or with
`--ci`, stderr gets a start line and the final timing. The report is on stdout.

## `uptide plan`

Discovery plus optional saved check results: `uptide plan --results check.json`. Takes
`--only`, `--json`, `--html`; never implicitly checks packages or fetches tarballs.

Unchecked or partially checked packages have unknown effort and suggest `uptide check <pkg>`.
Matching complete check results supply estimates: none, small, medium or large. Saved
results must match the repository, versions and workspaces; rerun after source changes.
Peer ranges from registry metadata and installed manifests constrain order; unavailable
metadata is disclosed. Without node_modules installed-peer constraints cannot be read.

### A shareable HTML report

```sh
uptide check zod --html                 # terminal output + <OS temp>/uptide/<repo>-<timestamp>.html
uptide check zod --html review.html     # explicit output path, relative to your current directory
uptide check zod --html --open          # open the default browser in an interactive terminal
uptide check zod --json --html --ci     # stdout stays JSON; the HTML path is printed on stderr
```

The report uses the terminal's migration plan: dependency summary first, then expandable
rules and sites, deprecated calls, analysis notes, and copyable next commands. Search
and severity filters work with plain inline JavaScript; the report remains readable
without it. Printing expands the details. Dark/light themes follow your system, with
`data-theme="light"` and `data-theme="dark"` overrides on the document element. Both list
and check use the same offline logo, typography, design tokens and square copy buttons.

One self-contained file, no network requests, external fonts, external images or analytics.
Default reports omit source code, file paths and workspace paths. Add `--details` for
reported source excerpts (three lines before/after, up to 50 excerpts per group), compiler
messages, analysis notes and VS Code file links. Missing or out-of-repository files are disclosed instead of read.
Long lines/excerpts and very large reports are trimmed with a notice to keep the file
below 300 KB. Review excerpts before sharing. `--open` never opens a browser in CI or
when output is redirected; `--open` requires `--html`.

## `uptide fix <package>` for a generic dependency

`uptide fix <any dependency>` works without a pack: there are no rules, so every
site with evidence goes to the agent, one at a time, and an edit is kept only if that
site's compiler error disappears and no new one appears. The verification and the publish
gate are the same as for a verified dependency.

- It needs the selected provider’s environment API key (see Choosing a model). Without one, or with `--no-llm`, it says what it cannot do
  and exits before creating a clone, a branch or an install.
- `--max-cost <usd>` (default 1) reserves the worst-case cost before every call, including retries. Sites
  not completed stay manual, the summary and the pull request say how many, and a run with
  sites left does not verify, so it cannot be published.
- The pull request opens with a note that no migration pack covers the package, and its
  risk is never Low.

## Choosing a model

Assisted fixes support Anthropic, OpenAI and Gemini (experimental), with the same prompts, tool,
verification and publish gate. Set the chosen provider's key in your environment:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`. Never put keys in repository
config or command arguments.

```sh
uptide fix zod --provider openai --model gpt-6.1-sol
UPTIDE_PROVIDER=gemini UPTIDE_MODEL=gemini-3.8-flash uptide fix stripe
uptide fix zod --max-cost 1
uptide fix zod --no-llm
```

For each setting, precedence is flag → `UPTIDE_PROVIDER` / `UPTIDE_MODEL` → nearest
`uptide.config.json` up to the Git root. Without a provider setting, detection checks
`ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`, then `GEMINI_API_KEY`; Anthropic remains the
overall default. An explicitly selected provider never falls back to another provider.
The selected provider/model prints before the fix starts, and spend prints at the end.

The optional config accepts **only** `provider` and `model` strings:

```json
{ "provider": "openai", "model": "gpt-6.1-sol" }
```

Unknown fields, nested settings and key-like values are rejected, including when flags
would override them. Keys are read only from the environment. No key: a generic fix
exits before cloning, installing or creating a branch; migration packs still apply
rule-based fixes and leave assisted sites manual. `--no-llm` disables all model calls.

Defaults checked against official documentation on 2026-10-04:

| Provider | Default | Reference |
| --- | --- | --- |
| Anthropic | `claude-sonnet-5-5` (`medium` effort) | [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview); selected after the storefront comparison |
| OpenAI | `gpt-6.1-sol` | [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), through the Responses API |
| Gemini | `gemini-3.8-flash` | [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |

See the [measured storefront comparison](provider-evaluation.md) for verification,
attempts, spend, reservations and time for each default.

Tool choice follows each model’s capabilities. Sonnet 5.5 uses `auto` with a strict
`submit_patch` schema and a tool-only system instruction; Sonnet 4.6, OpenAI and Gemini
use forced tool calls. Missing or invalid calls consume an attempt and their reported
cost, then receive the feedback “respond only by calling submit_patch”. HTTP 429 is
reported as rate limiting, waits for `Retry-After` (60 seconds when absent), and retries
only when another reservation fits the budget.

`--max-cost` defaults to **$1 per package**, including zod and stripe. Before every
call and retry, Uptide reserves its worst-case input and maximum output cost. A call
that would exceed the remaining budget is never sent. Actual returned usage replaces
the reservation; failures without valid usage keep the full reservation, shown
separately as unknown spend. Rejected patches still consume budget. Unfinished sites
remain manual and cannot pass the publish gate. Unknown models use the provider's
highest listed rates with a warning. See [model pricing](model-pricing.md) for
rates, token estimation and the scope of accounting.

`OPENAI_BASE_URL` selects an OpenAI **Chat Completions-compatible, not verified**
endpoint. Uptide appends `/chat/completions` to the supplied API base URL and uses
Bearer authentication, strict functions and forced `submit_patch`. The official OpenAI
endpoint uses Responses when this override is absent. HTTPS is required, except HTTP
localhost for local servers. Custom deployments must support this protocol and the
supplied model ID; Azure-specific authentication and routing are not inferred. Custom
endpoint prices may differ from the built-in OpenAI table.

**Privacy:** assisted fixes send the finding, enclosing code snippet and compiler
error to the provider you chose (or your `OPENAI_BASE_URL`). Your provider's data policy
applies. `--no-llm` keeps assisted fixes off. Anonymous telemetry, when enabled, adds
only the provider and a public model ID; private/custom model IDs become `custom`.

## `uptide fix <package>`, step by step

Everything happens in a temporary clone of your repository, never in your checkout.

1. **Starts from your local commit.** The clone is made from your local repository at the
   commit you have checked out, never from the remote. Uncommitted changes are left out and
   listed. A branch that is ahead of or behind its upstream is migrated as it is, with one
   line saying so. With `--pr` the run stops before any work when the base branch on `origin`
   does not contain that commit (push it first, or pass `--base <branch>`), and when the
   working tree has uncommitted changes (commit them, or pass `--allow-dirty`): the PR must
   hold the migration and nothing else. A commit that is behind the base only gets a
   warning. The remote is compared as last fetched: run `git fetch origin` if you pushed
   from elsewhere. It works on a
   new branch `uptide/<package>-<version>`. Nothing is pushed unless you pass `--pr --yes`,
   or later run `uptide pr --branch <branch> --yes`, which loads the stored run, checks the
   branch is still at the verified commit (else `uptide verify`), prints which repository
   the PR goes to (a fork itself, never its parent unless `--repo` names it) and opens it
   with the stored description.
2. **Upgrades.** Bumps the version in every workspace that declares it (and in pnpm
   catalogs), preserving `^`, `~`, or exact ranges. Installs run in a temporary git worktree with lifecycle scripts disabled. The real package manager produces the lockfile; Uptide rejects changes outside the target dependency subtree before copying it back unchanged. One commit.
   Packages that must move with it move in the same install and commit, each at the version
   that agrees with the target (see "Companions" in [architecture](./architecture.md)):
   `fix ai` also bumps `@ai-sdk/react`, `@ai-sdk/provider` and every installed `@ai-sdk/*`
   provider, and `check`'s plan, the summary (`With`) and the PR description say which and
   why. When one of them has no release that agrees, `fix` stops before changing anything.
3. **Rule-based fixes.** Deterministic rewrites for the changes it has rules for, such as
   zod's `required_error` / `invalid_type_error` (add `--include-deprecated` for
   `z.string().email()`-style chains). One commit.
4. **Assisted fixes (optional).** With the selected provider’s API key set, sites the rules cannot
   migrate go to the LLM one at a time. A patch is kept only if it removes its compiler
   error and introduces none; otherwise it is reverted and the site is left for you.
   `--no-llm` turns this off.
5. **Verifies.** Type-checks with *your* TypeScript (or the bundled compiler when absent) before and after and subtracts the
   errors you already had; runs the tests of the affected workspaces (each workspace's
   `test` script, else the vitest or jest configuration that covers it, scoped to the
   tests related to the migrated files, else the root `test` script) and reports what ran;
   by default only tests that need no database, cache or queue run, and the report counts the
   integration tests it left out (`--with-services --yes` includes them, after printing what
   they connect to); formats the files it edited, and only those, with your formatter and runs your lint
   (biome, prettier, eslint) on them, where a new lint failure fails verification; for zod,
   compares v3 and v4 behaviour of your schemas on generated inputs. The exit code is 0
   only if no new type error remains and tests pass. Passing compilation does not prove
   runtime equivalence, so the report (`pr-body.md` and `report.html` next to the stored
   run in `.git/uptide/<branch>/`) lists what to review.

Stripe API-version changes are never rewritten by rule: they are assisted or left for
you, with the relevant changelog entries and a dashboard/webhook checklist in the report.

## Pull request descriptions

`fix` stores the run in `.git/uptide/<branch>/report.json`, with the verified commit, Uptide version/commit, rule IDs, patches, agent
reasoning and run metadata. PR bodies show a computed risk, a five-row summary, changes
grouped by rule, and actionable review items.

To regenerate an existing description without another migration or any push:

```sh
uptide pr-body --pr 12 --preview           # review the complete proposal first
uptide pr-body --pr 12                     # update only the description
# For a retained eval run, add --cwd /path/to/target/repo --run /path/to/report.json.
```

The selected PR must match the stored run's branch and verified commit. Risk is Low
for verified rule-only edits, Medium for agent edits, sensitive paths or missing tests,
and High for unverified sites, behavior changes or remaining manual work. Unchecked
schema samples are called out separately; they do not imply unresolved compiler sites.

Builds embed the Uptide commit and whether its source checkout had working-tree changes.
`pnpm exec tsx scripts/reverify-run.ts <run.json> [output.json]` refreshes behavior
and type verification on the recorded commit without installing or changing source.
Diffs, file lists, verification and run details are collapsed; the Action comment and
terminal share the compact migration renderer.

## `uptide pack new|test` (contributors)

Packs are written in an uptide checkout; the contract is [docs/packs.md](packs.md) and the
steps are in [CONTRIBUTING.md](../CONTRIBUTING.md#write-a-pack). `pnpm uptide` runs the CLI
from source.

```sh
pnpm uptide pack new ai --from ">=6 <7" --to ">=7 <8" --maintainer @you
pnpm uptide pack test ai                 # fixtures, then check on each ground-truth repository
pnpm uptide pack test --json             # every pack, for CI
pnpm uptide pack test ai --offline       # cached repositories only
pnpm uptide pack test ai --fixtures-only
pnpm uptide pack test ai --write         # record the measured status in verification.json
pnpm uptide pack test ai --fixtures-only --update-fixtures  # write after.ts from the rules
```

`pack test` prints precision and recall per rule, overall and for breaking findings, and
every false positive and false negative as `repository  file:line  rule`. Exit codes: **0**
every pack passed, **1** a false positive among breaking findings, a failing fixture, or a
`verification.json` the run does not support, **2** it could not run (not in a checkout,
bad arguments).

## `uptide telemetry on|off|status|show`

Anonymous telemetry is off by default. The first interactive run asks once, default
no; CI, JSON, help/version and piped runs never prompt. `on` and `off` save the local
preference, `status` explains effective consent and transport configuration, and
`show` prints the last sanitized event as JSON without sending it. `--json` is
available for all four actions. Turning it off clears local identifiers and the event.

`UPTIDE_TELEMETRY=0` always disables it; CI (including `--ci`) requires an explicit
`UPTIDE_TELEMETRY=1`, regardless of saved consent. Builds without a capture key send
nothing. Events contain aggregate usage and proven public npm versions, never code,
paths, IP addresses or repo/user names. Storage is PostHog EU with a 90-day retention
policy. See [telemetry.md](telemetry.md) for exact fields and deployment requirements.
