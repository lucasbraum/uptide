# CLI reference

`uptide --help` and `uptide <command> --help` are the authority; this page adds what help
cannot show.

## `uptide list`

Fast discovery with no compile, install, tarball downloads or execution of repository code.
Requires a lockfile (exact manifest versions also work once the repository is detected).
Shows every outdated direct dependency, its current and latest version, major/minor/patch,
verified/generic tier, import-file count, direct call/new/JSX count, top symbols and workspaces.
Majors first, then importing files and call sites, with name/version tie breakers.

- `--all`: expand minor/patch rows, collapsed by default.
- `--json`: every row and per-package discovery failure, in deterministic order.
- `--cwd <dir>`, `--ci`, `--no-color`: shared options.

Unused means no static source import was found. Script tools, config plugins and type
packages may still be needed. Syntax scanning includes imports, re-exports, require,
import-equals, literal dynamic imports and JS/TS/JSX/TSX; it does not resolve indirect aliases
or reflection. Counts are repository-wide when several workspaces lock different versions.
Internal workspace dependencies and local/git/URL specifiers are excluded from registry queries.

## `uptide check <package...>`

Examples: `uptide check zod`, `uptide check zod stripe`. No names prints a short pointer to
`uptide list` and exits 2, before reading or analyzing a repository. There is no automatic
whole-repository budgeted mode or `--max-time` flag.

| Flag | Meaning |
| --- | --- |
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

Every row says `verified` or `generic`. Verified: a migration pack covers the upgrade.
Generic: no pack; a finding is breaking only with evidence, which `--details` names under
each site:

- your code does not compile against the target at that site;
- the runtime probe loaded the target and the export is gone or changed;
- a `require()` of a package whose target is ESM-only;
- the import of a name the target no longer exports.

Everything else the declaration diff suggests is listed as unverified in `--details` and
counted on the first screen only as "N unconfirmed".

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
without it. Printing expands the details. Dark/light themes follow your system.

One self-contained file, no network requests, web fonts, images, or analytics. It includes
only the reported source excerpts (three lines before/after, up to 50 excerpts per group),
with VS Code file links. Missing or out-of-repository files are disclosed instead of read.
Long lines/excerpts and very large reports are trimmed with a notice to keep the file
below 300 KB. Review excerpts before sharing. `--open` never opens a browser in CI or
when output is redirected; `--open` requires `--html`.

## `uptide fix <package>` for a generic dependency

`uptide fix <any dependency>` works without a pack: there are no rules, so every
site with evidence goes to the agent, one at a time, and an edit is kept only if that
site's compiler error disappears and no new one appears. The verification and the publish
gate are the same as for a verified dependency.

- It needs `ANTHROPIC_API_KEY`. Without one, or with `--no-llm`, it says what it cannot do
  and exits before creating a clone, a branch or an install.
- `--max-cost <usd>` (default 1) stops the agent once its calls have cost that much. Sites
  not attempted stay manual, the summary and the pull request say how many, and a run with
  sites left does not verify, so it cannot be published.
- The pull request opens with a note that no migration pack covers the package, and its
  risk is never Low.

## `uptide fix <package>`, step by step

Everything happens in a temporary clone of your repository, never in your checkout.

1. **Starts clean.** It needs a git repository with a clean working tree, and works on a
   new branch `uptide/<package>-<version>`. Nothing is pushed unless you pass `--pr --yes`,
   or later run `uptide pr --branch <branch> --yes`, which loads the stored run, checks the
   branch is still at the verified commit (else `uptide verify`), prints which repository
   the PR goes to (a fork itself, never its parent unless `--repo` names it) and opens it
   with the stored description.
2. **Upgrades.** Bumps the version in every workspace that declares it (and in pnpm
   catalogs), preserving `^`, `~`, or exact ranges. Installs run in a temporary git worktree with lifecycle scripts disabled. The real package manager produces the lockfile; Uptide rejects changes outside the target dependency subtree before copying it back unchanged. One commit.
3. **Rule-based fixes.** Deterministic rewrites for the changes it has rules for, such as
   zod's `required_error` / `invalid_type_error` (add `--include-deprecated` for
   `z.string().email()`-style chains). One commit.
4. **Assisted fixes (optional).** With `ANTHROPIC_API_KEY` set, sites the rules cannot
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
