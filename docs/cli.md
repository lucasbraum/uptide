# CLI reference

`uptide --help` and `uptide <command> --help` are the authority; this page adds what help
cannot show.

## `uptide check`

| Flag | Meaning |
| --- | --- |
| `--only zod,stripe` | dependencies to check (the default); `--only all` checks every dependency |
| `--target zod@4.6.5` | exact target, repeatable; default is `latest` |
| `--details` | every site, reason, compiler message and analysis note |
| `--verbose` | one progress line per analysis phase, with timings |
| `--cwd <dir>` | repository to work on |
| `--json` | the full report as JSON on stdout |
| `--ci` | plain log output: no color, no spinner (`NO_COLOR` is respected too) |

Exit codes, for scripts and CI: **0** nothing breaking, **1** breaking changes found,
**2** uptide could not answer (bad arguments, unsupported repository, no network). When
it cannot answer, it says why and prints the exact command to run next.

While it runs, a terminal shows one live line with the current phase, which disappears
when the work ends; `--verbose` keeps one line per phase with timings. In a pipe or with
`--ci`, stderr gets a start line and the final timing. The report is on stdout.

### A shareable HTML report

```sh
uptide check --html                 # terminal output + <OS temp>/uptide/<repo>-<timestamp>.html
uptide check --html review.html     # explicit output path, relative to your current directory
uptide check --html --open          # open the default browser in an interactive terminal
uptide check --json --html --ci     # stdout stays JSON; the HTML path is printed on stderr
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

## `uptide fix`, step by step

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
