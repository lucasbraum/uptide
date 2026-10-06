# Uptide

**Migrations you can merge.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Uptide finds what a dependency upgrade breaks in your code, migrates it, and proves it with
your compiler and tests. TypeScript repositories; verified migrations for **zod 3 → 4** and
**stripe** today.

## Quickstart (30 seconds)

No account, no config. In your repository:

```sh
npx uptide list                          # fast discovery; no install or compilation
npx uptide check zod                     # analyze one or more named dependencies (install first)
npx uptide fix zod                # migrate on a new branch, verified; nothing is pushed
npx uptide pr --branch uptide/zod-4.6.5   # prints the plan; add --yes to push and open the PR
```

`npx uptide ` alone shows where zod and stripe stand: installed, latest, majors behind.
Requires Node 20 or newer. Works with npm, pnpm and Yarn (node-modules linker).

## Before and after

[`fixtures/repos/storefront`](fixtures/repos/storefront) is a small pnpm workspace in this
repository, written to exercise Uptide: two packages on zod 3 and stripe 14, with a few
tests. Everything below is real output from it.

**Before: `check`.** What breaks, where, and who can fix it:

```console
$ npx uptide check zod stripe
uptide check · storefront · pnpm · 8.5s

zod                     3.25.76 → 4.6.5    major · latest on npm      verified   ✗ 28 breaking in 7 files   24 auto-fixable · 4 need the agent (LLM)
stripe (packages/api)   14.25.0 → 23.0.0   9 majors behind · latest on npm   verified   ✗ 4 breaking in 3 files    1 auto-fixable · 3 need the agent (LLM)

zod   28 breaking · compiled against 4.6.5: 28 new type errors
  ✗ New error API (required_error → error)   24 sites          auto-fixable
  ✗ ZodTypeDef removed                       1 fix, 3 errors   needs the agent (LLM)
  ✗ .ip() removed                            monitoring.ts:6   needs the agent (LLM)
  ! 15 deprecated calls (.uuid, .datetime, .email, ...)   8 auto-fixable

stripe   4 breaking · compiled against 23.0.0: 4 new type errors
  ✗ Test fixture casts widened                   renewal.test.ts:7   auto-fixable
  ✗ Subscription billing period moved to items   2 sites             needs the agent (LLM)
  ✗ apiVersion no longer matches the SDK         client.ts:9         needs the agent (LLM)
    1 API change since 2023-10-16 affects your code

Next
  npx uptide fix zod                       migrate on a new branch, verify, no push
  npx uptide fix stripe                    migrate on a new branch, verify, no push
  npx uptide plan --only 'zod,stripe'      the order to upgrade in, with the effort
  npx uptide check zod stripe --details    every site and reason
```

`list` reads manifests, lockfiles, source imports and registry metadata. PRIORITIES come
first: up to five rows, most urgent first, each with a one-line reason and the command to run
(known advisories for the installed version, a deprecated version, a major line with no release
in a year, a peer range holding another upgrade back, two or more majors behind; cheaper
upgrades first among equals). When nothing is urgent it says so and suggests the cheap batch of
minor/patch upgrades that touch few files. The rules and weights are in
[docs/priorities.md](docs/priorities.md); nothing in `list` calls an LLM. Groups follow,
with a command such as `uptide check --group nestjs` to check their members together: a scope
is one family (`@radix-ui/*`), and packages also group across scopes when a peer range of one's
latest version needs the other, or when both pin the same exact version of a dependency
(`ai + @ai-sdk/*`). Each group says why.
External peers are members labeled by the package that requires them. Each member keeps its own
classification and evidence. A group header follows its lead; members with independent usage
appear in their own section, and the group command/JSON still includes the complete member list. Each row gives current → latest, upgrade
kind and major gap, verified/generic tier, importing files, calls, references and top symbols.
Workspace columns appear only in workspaces. Top symbols require `--details`; terminal
columns fit the available width, and only verified packages carry a tier tag. Minor/patch upgrades, tooling and possibly
unused packages are collapsed; `--all` expands them. Tools used by scripts/configs, runtime
types and required direct dependencies/peers are classified separately from possibly unused packages. This includes
package.json tool settings (including keys matching dependency names), tool rc file presence,
installed bin names (including collisions), hook/task commands, Karma plugin mappings and auto-loading, stylesheet
imports and HTML assets under node_modules. Expanded rows explain the evidence; “possibly
unused” means no usage was found by Uptide's scan, so verify before removing. Legacy lint-staged
`linters` maps and current flat glob maps both supply commands. Their `ignore` entries are
neither commands nor source-scan exclusions.

Registry settings use environment overrides, project and user `.npmrc` files, scoped
registries and host/path-scoped credentials. Known advisories come from one request to npm's
bulk advisory endpoint with the names and installed versions of packages served by the public
npm registry; packages from another registry or scope are never sent there. A failure or
timeout (5 s) says “advisories not checked” and never fails the run; `--no-advisories` (or
`"advisories": false` in `uptide.config.json`) never sends the request. Runtime dependencies
rank before dev-only ones, and an advisory row names its smallest fix (same major or not). Publish dates for the
support window come from the full registry document of packages with a newer major, under the
same 5-second deadline. Discovery otherwise uses abbreviated metadata with up to
16 concurrent requests, a 10-second timeout per attempt (including response bodies), and one
retry for timeouts or HTTP 5xx. Only a host that returns 401, 403 or 405 is blocked for the
rest of that run. Credentials and registry responses are never written to the discovery cache.
Unresolved packages stay in JSON's `unknown` list, the summary reports the shared reason (e.g. “3 not checked (access denied)”)
or simply “N not checked” for mixed reasons,
and HTML keeps one named row per incomplete package. Repeated failures are grouped by host and
reason (more than five network errors, or multiple access failures); `--details` lists names.
Successful packages remain visible; incomplete discovery exits 2. Analysis commands retain
their normal retry policy.

Git/GitHub, local file/link/workspace dependencies and HTTP(S) sources are intentional skips,
including `npm:` aliases pointing to those sources. They appear as collapsed “not checked:
non-registry source (github)” lines (expand with `--all` or `--details`) and a collapsed HTML
section; JSON keeps them in `skipped`. They do not make discovery incomplete or change exit 0.
Registry aliases resolve the real package name, retaining their local dependency names for
usage scanning and adding `registryName` to aliased upgrade rows in JSON.
`--json` gives every row. `--html [--open]` creates a report styled like check, with copyable
commands and no source code or file paths by default; `--details` adds file lists.
Usage is syntactic: indirect aliases and reflection are not followed. With different locked
versions, usage is shown across the repository.

`list --verbose` prints phase timings and file counts to stderr: manifest read, registry,
source scan, config scan and render. Source scan includes file traversal and stylesheet/HTML
assets; config scan includes configuration parsing and classification. Render covers terminal/JSON
and optional HTML writing, excluding browser launch. With `--json`, verbose phase/count data is
also included under `timing`; default JSON stays unchanged. This helps distinguish registry
latency from repositories with many source/config files. Configs are read statically, never executed.

The scan skips only `node_modules`, `.git`, `coverage`, `dist`, `build`, `bower_components`,
`vendor`, generated-file patterns (`*.min.js`, `*.bundle.js`, `*.map`), and root/nested `.gitignore`
rules. Git patterns are relative to their declaring directory and support negation. Tool scopes
(`.prettierignore`, `.eslintignore`, `.stylelintignore`, `standard.ignore`, lint-staged `ignore`)
do not exclude application code: files a formatter or linter skips may still use dependencies.
A dependency-name text gate and lexer select candidates for full syntax parsing; bindings,
shadowing, calls and references still use the syntax parser. Large batches (at least 32
candidates / 8 MB) use up to four CPU workers; smaller batches avoid worker startup overhead.

If Git rules exclude **more than 50%** of candidate application JS/TS files, the summary,
HTML and `--verbose` warn with the matching patterns and counts. JSON includes `scanWarnings`;
a usage warning alone does not change the exit code. Candidates exclude built-in/generated
artifacts, declaration files and tool configs, and are counted before dependency text/lexer
filtering. Git-ignored subtrees get a filename-only audit without reading/parsing source;
built-in excluded directories are never enumerated. Verbose output shows candidates, excluded
sources, parsed files, workers and per-reason skip counts.

`check` requires names (`uptide check zod stripe`). With no names it points to `uptide list`
and exits 2 before doing work. It retains tiers and partial results per named package.

`uptide plan` uses discovery, with **unknown** effort until a matching check result is supplied:

```sh
npx uptide check zod stripe --json > check.json
npx uptide plan --results check.json
```

Planning never implicitly compiles every dependency or downloads tarballs. Matching saved
results (same repository, versions and workspaces) supply effort estimates; rerun `check`
after source changes. Registry peer metadata and available installed manifests constrain
the upgrade order. Missing peer metadata is disclosed.

**After: `fix`**, one dependency at a time, each on its own verified branch:

```console
$ npx uptide fix zod
uptide fix · zod 3.25.76 → 4.6.5 (latest on npm) · verification passed · 36s

  Risk      Medium: request validation in webhooks
  Changes   29 sites in 8 files · 25 auto-fixed · 4 fixed by the agent (LLM)
  Types     ✅ 29 errors after the bump → 1 (1 pre-existing)
  Behavior  ✅ 9 schemas identical · 2 not checked · 21/21 custom-message assertions
  Tests     ✅ 5 tests in 3 files passed
```

No compiler sees this one: zod 4 words its default messages differently, and a test that
asserted the old wording failed after the migration. Uptide updated it and says so in the
pull request, so you can check that nothing else reads that text:

```diff
-    expect(parsed.error?.issues[0]?.message).toBe('Required');
+    expect(parsed.error?.issues[0]?.message).toBe('Invalid input: expected string, received undefined');
```

```console
$ npx uptide fix stripe
uptide fix · stripe 14.25.0 → 23.0.0 (latest on npm) · verification passed · 41s

  Risk      High: behavior changes
  Changes   6 sites in 3 files · 3 auto-fixed · 3 fixed by the agent (LLM)
  Types     ✅ 5 errors after the bump → 1 (1 pre-existing)
  Behavior  ⚠️ 1 of 570 API changes affects your code · 47 touch resources you use (8 breaking)
  Tests     ✅ 3 tests in 2 files passed · the test script of packages/api
```

Stripe moved a subscription's billing period from the subscription to its items. Uptide
added a `subscriptionPeriod` helper and migrated the code that read the old fields:

```diff
-    renewsAt: new Date(subscription.current_period_end * 1000),
+    renewsAt: new Date(period.end * 1000),
```

The risk is High on purpose: types and tests pass, but a new API version changes what
Stripe sends, and the pull request asks what only you can answer (which item's period
counts when a subscription has several).

The one type error left in both runs is the fixture's own, there on purpose: errors a
repository already had are subtracted, never blamed on the upgrade.

## What is supported

Every direct dependency can be discovered and selected for analysis. What differs is how much Uptide knows about it:

| Tier | Dependencies | What you get |
| --- | --- | --- |
| **Verified** | zod 3 → 4, stripe 14 and newer | A migration pack: rules written for that dependency, a guide for the agent, behavior checks (zod schemas compared on generated inputs; Stripe changelog filtered to what you call), and ground truth the pack is scored against. `fix` migrates by rule first, by agent for the rest. |
| **Generic** | any other dependency | The same analysis without a pack. A finding is called breaking only when your compiler or the runtime probe confirms it, or when it is a `require()` of an ESM-only package or an import of a removed export; everything else is in `--details`. `fix` migrates with the agent alone, under the same verification, and says so in the pull request. |

The tier is on every row of `check`, in the HTML report and in the pull request. A generic
`fix` needs a provider API key (there are no rules to fall back on; without a key it says
so and changes nothing), stops at `--max-cost` (default $1) and reports what it did not
complete. Its pull request opens with a note that no pack covers the package: every edit
was kept on the compiler's word and deserves a careful review.

- **Languages:** TypeScript, and JavaScript the compiler can see (`allowJs`).
- **Package managers:** `check` on npm, pnpm (workspaces and catalogs), Yarn classic and
  bun (text lockfile); `fix` on npm (lockfile v2/v3), pnpm, and Yarn classic/Berry with the
  node-modules linker.
- **Not supported:** Yarn Plug'n'Play, bun's binary lockfile, Deno.

## Choosing a model

Assisted fixes support Anthropic, OpenAI and Gemini, with the same prompts, tool,
verification and publish gate. Set the chosen provider's key in your environment:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`. Never put keys in repository
config or command arguments.

```sh
npx uptide fix zod --provider openai --model gpt-6.1-sol
UPTIDE_PROVIDER=gemini UPTIDE_MODEL=gemini-3.8-flash uptide fix stripe
npx uptide fix zod --max-cost 1
npx uptide fix zod --no-llm
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

Measured on storefront (2026-10-04; USD from returned usage). Each cell lists
**zod / Stripe**; every run has a $1 ceiling:

| Provider | Model | Verified | Agent sites | Attempts | Cost USD |
| --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-sonnet-5-5 (medium)` | pass / pass | 4 / 3 | 2 / 2 | $0.013244 / $0.021592 |
| OpenAI | `gpt-6.1-sol` | pass / pass | 4 / 3 | 2 / 3 | $0.006806 / $0.018677 |
| Gemini | `gemini-3.8-flash` | fail / fail | 0 / 0 | 12 / 9 | $0.000000 / $0.000000 |

Gemini's serial reruns failed after HTTP 503/429 and transport errors, despite a
successful protocol smoke. Its zero confirmed cost excludes $0.473901 / $0.368667
retained for unreported usage; it is not a claim of zero possible billing. Full trials, reservations, times,
exact echoed IDs and the Sonnet 4.6/high/medium comparison are in the
[provider evaluation](docs/provider-evaluation.md). These single fixture trials are
not a general model ranking.

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
highest listed rates with a warning. See [model pricing](docs/model-pricing.md) for
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

## How verification works

`fix` never works in your checkout. It clones your repository into a temporary directory
and, there:

1. **Baseline.** Type-checks and notes the errors you already have.
2. **Upgrades.** Bumps the version everywhere it is declared. Your package manager
   produces the lockfile, with lifecycle scripts disabled; a lockfile change outside the
   upgraded dependency's subtree is rejected.
3. **Rule-based fixes.** Deterministic rewrites, only at the sites `check` reported.
4. **Assisted fixes (optional; all there is for a generic package).** Sites no rule covers
   go to the LLM one at a time. A patch
   is kept only if it removes its compiler error, introduces none, and passes the pack's
   own validator; otherwise it is reverted and the site is left for you.
5. **Verifies.** Type-checks with *your* TypeScript and subtracts the baseline; runs the
   tests related to the files it touched; formats and lints only those files with your
   tools. Tests that need a database, cache or queue do not run unless you ask
   (`--with-services --yes`), and the report counts what was left out.

The exit code is 0 only if no new type error remains and the tests pass. You get the branch
as a ref in your repository and the run stored in `.git/uptide/`; your branch, files, hooks
and git config are compared before and after and must be identical. Nothing is pushed
until you run `uptide pr` or pass `--pr --yes`.

Passing compilation does not prove runtime equivalence. The report says what was verified,
what was not, and what to review; server API changes (Stripe API versions) are never
rewritten by rule.

## Privacy

Analysis runs locally. Code snippets go to your chosen LLM provider (Anthropic, OpenAI or Gemini), only
for assisted fixes in `uptide fix`, and only with your own API key from ANTHROPIC_API_KEY,
OPENAI_API_KEY or GEMINI_API_KEY: for each
site the rules cannot migrate, the finding, the enclosing function and the compiler
error. `uptide fix --no-llm` turns assisted fixes off. No account.
Anonymous telemetry is off by default and asks for consent in an interactive terminal.
Set UPTIDE_TELEMETRY=0 to disable it. No IP, code, paths or repo names are collected.
Other network use: your npm registry for package metadata and tarballs, npm's advisory
endpoint from `list` (public package names and installed versions; `--no-advisories` turns
it off), PostHog EU only
after telemetry opt-in, and GitHub when you pass `fix --pr` or run `pr` / `pr-body`.

There is no Uptide server. With telemetry off (the default):

| | Where it runs | What leaves your machine |
| --- | --- | --- |
| `list`, `plan` | locally | package names/versions requested from your npm registry, and `list` sends public packages' names and installed versions to npm's advisory endpoint; metadata only, no source code |
| `check` | locally | nothing of yours; it downloads package tarballs from your npm registry. No LLM call, and nothing in your repository is executed. |
| `fix`, rules and verification | locally, in a temporary clone | nothing of yours |
| `fix`, assisted fixes | Your chosen provider's API, with **your** environment API key | per site no rule covers: the finding, the enclosing function or declaration, and the compiler error |
| `pr`, `fix --pr` | GitHub, through your own `gh` | the branch and the pull request, when you say so |

Without a key, or with `--no-llm`, those sites are listed for you instead. The full model, and how to report a problem, is in
[SECURITY.md](SECURITY.md).

## Optional anonymous telemetry

On your first interactive run, Uptide asks once whether to share anonymous usage;
pressing Enter means **no**. CI and piped/JSON runs never prompt. Use
`uptide telemetry on`, `off`, `status`, or `show` (the last sanitized event).
`UPTIDE_TELEMETRY=0` always disables collection. CI requires `UPTIDE_TELEMETRY=1`,
even when the saved preference is on.

With consent, events contain a random installation ID, a salted repository hash,
command/version, proven public npm package versions, aggregate counts, verification
result, timings and cost. No IP, code, paths, repository names or user names are
collected. Data is stored in **PostHog Cloud EU**, with a **90-day retention policy**.
Delivery is best effort in a short-lived background process; unavailable telemetry
never fails a command. Builds without a capture key send nothing.
See [the exact fields, controls and deployment requirements](docs/telemetry.md).

## Exit codes

For scripts and CI: **0** nothing breaking, **1** breaking changes found,
**2** uptide could not answer (bad arguments, unsupported repository, no network). When
it cannot answer, it says why and prints the exact command to run next.

One dependency failing (a registry error, an analysis that ran out of memory) does not
empty the report: the others are shown and the failed one is named with its reason. The
exit code is then 1 if anything breaking was found, else 2, because the question was not
fully answered. `list` exits 2 when discovery is incomplete, while retaining successful rows.
`fix` and `verify` exit 0 when the migration verifies and 1 when it does not; `plan` exits
0 with a plan, or 2 when discovery is incomplete.

Analysis concurrency uses CPU count and available memory (including reclaimable memory
reported by the OS), reserving at most about 60% for worker heaps and estimated overhead.
Named checks build their baseline and target programs from the files importing those packages;
TypeScript follows their imports. Workspaces with no such imports load no program. The estimate
uses only that reachable graph. Workspaces run serially with the full reservation when they
cannot fit in parallel; unexpected parallel memory failures get one serial retry. Only a scoped
program that cannot fit alone is skipped, with its workspace, estimate and available budget.
`--workspaces` and `UPTIDE_WORKER_HEAP_MB` can lower limits, never bypass the memory cap.
Compiler allocations are estimates; unexpected worker failures still preserve other results.

## Documentation

- [CLI reference](docs/cli.md): flags, the HTML report, each step of `fix`, pull request
  descriptions
- [GitHub Action](docs/github-action.md): check and migrate Renovate and Dependabot pull
  requests
- [Architecture](docs/architecture.md) and [decisions](docs/decisions/): how it works and why
- [Security](SECURITY.md): the isolation model
- [Contributing](CONTRIBUTING.md): setup, tests, how migration packs work
- [Development](docs/development.md) and [releasing](docs/releasing.md)

## License

[Apache-2.0](LICENSE). Releases up to and including 0.3.0 were published under the MIT
license; 0.4.0 and later are Apache-2.0.

The published CLI is one bundle: it inlines its dependencies. The notice for every package
in that bundle, with the full text of its license, ships in the npm package as
`THIRD-PARTY-NOTICES` and is generated from the bundle itself at build time.
