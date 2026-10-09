---
title: uptide check
description: Which of your call sites a dependency upgrade breaks, what fixing them costs, and how to read and share the report.
---

# `uptide check`

For anyone about to upgrade a named dependency and asking what it breaks in their code.
`uptide check --help` lists the flags; the words on each row are in [concepts](../concepts.md).

## Running it

Examples: `uptide check zod`, `uptide check zod stripe`, `uptide check --group nestjs`.
`check` requires names: with no names or group it prints a short pointer to `uptide list`
and exits 2, before reading or analyzing a repository. There is no automatic
whole-repository budgeted mode or `--max-time` flag. Install dependencies first.

| Flag | Meaning |
| --- | --- |
| `--group nestjs` | discover the named release group and check all members, including required peers |
| `--only zod,stripe` | compatibility alias for positional package names; `all` is rejected |
| `--target zod@4.6.5` | exact target, repeatable; bare version with one selected package |
| `--details` | every site, reason, compiler message and analysis note |
| `--all` | with `--details`: also findings under 50% confidence |
| `--verbose` | one progress line per analysis phase, with timings |
| `--workspaces <n>` | maximum parallel workspaces, capped by memory and CPUs |
| `--no-compile`, `--no-runtime` | skip the compile against the target, or the sandboxed runtime probe |
| `--all-deps` | also analyze `@types/*` and dependencies the repository never imports |
| `--html [path]`, `--open` | a shareable report (below) |
| `--cwd <dir>` | repository to work on |
| `--json` | the full report as JSON on stdout |
| `--ci` | plain log output: no color, no spinner (`NO_COLOR` is respected too) |

While it runs, a terminal shows one live line with the current phase, which disappears when
the work ends; `--verbose` keeps one line per phase with timings. In a pipe or with `--ci`,
stderr gets a start line and the final timing. The report is on stdout.

## What the report says

A real run on [`fixtures/repos/storefront`](../../fixtures/repos/storefront), the public
fixture in the Uptide repository (two packages on zod 3 and stripe 14):

```console
$ npx uptide check zod stripe
uptide check · storefront · pnpm · 8.5s

zod                     3.25.76 → 4.6.5    major · latest on npm      verified   ✗ 28 breaking in 7 files   24 auto-fixable · 4 need the agent (LLM)
stripe (packages/api)   14.25.0 → 23.0.0   9 majors behind · latest on npm   verified   ✗ 4 breaking in 3 files    1 auto-fixable · 3 need the agent (LLM)

zod   28 breaking · compiled against 4.6.5: 28 new type errors
  compiled 11 of 11 files in 2 workspaces with the repo's TypeScript 5.9.3
  ✗ New error API (required_error → error)   24 sites          auto-fixable
  ✗ ZodTypeDef removed                       1 fix, 3 errors   needs the agent (LLM)
  ✗ .ip() removed                            monitoring.ts:6   needs the agent (LLM)
  ! 15 deprecated calls (.uuid, .datetime, .email, ...)   8 auto-fixable

stripe   4 breaking · compiled against 23.0.0: 4 new type errors
  compiled 7 of 7 files in 1 workspace with the repo's TypeScript 5.9.3
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

Each row: installed → target, how far behind, the tier, the verdict (breaking sites and
files), and who can fix them (a rule, the agent, or you). Under each package: the verdict
with what verified it, the [coverage line](../concepts.md#the-coverage-line), one line per
rule or root cause, and deprecated calls. `--details` adds every site with its reason and
compiler message.

Breaking means confirmed: the compiler, the runtime probe or a pack
([concepts](../concepts.md#breaking-means-confirmed)). What the declaration diff suggests but
nothing confirms is listed as possible impact and never counted.

Packages that must move with the upgrade (`@types/react` with `react`, `@ai-sdk/*` with
`ai`) are named on a companions line, and `check`'s plan says which and why; `fix` moves
them in the same install and commit.

## Partial results

A dependency whose analysis fails (the registry refuses, a tarball cannot be fetched, a
workspace runs out of memory) is listed under "Not analyzed" with the reason, and the others
are reported as usual. A failing package or workspace does not erase successful results:
`check` retains tiers and partial results per named package.
Partial or failed analysis is never called clean; a skipped workspace is not a safety verdict.
How memory decides what runs in parallel, and what `UPTIDE_WORKER_HEAP_MB` and
`--workspaces` can change: [troubleshooting](../troubleshooting.md#memory-limits).

## A shareable HTML report

```sh
uptide check zod --html                 # terminal output + <OS temp>/uptide/<repo>-<timestamp>.html
uptide check zod --html review.html     # explicit output path, relative to your current directory
uptide check zod --html --open          # open the default browser in an interactive terminal
uptide check zod --json --html --ci     # stdout stays JSON; the HTML path is printed on stderr
```

The report uses the terminal's migration plan: dependency summary first, then expandable
rules and sites, deprecated calls, analysis notes, and copyable next commands. Search and
severity filters work with plain inline JavaScript; the report remains readable without it.
Printing expands the details. Dark/light themes follow your system, with
`data-theme="light"` and `data-theme="dark"` overrides on the document element. Both `list`
and `check` use the same offline logo, typography, design tokens and square copy buttons.

One self-contained file, no network requests, external fonts, external images or analytics.
Default reports omit source code, file paths and workspace paths. Add `--details` for
reported source excerpts (three lines before and after, up to 50 excerpts per group),
compiler messages, analysis notes and VS Code file links. Missing or out-of-repository files
are disclosed instead of read. Long lines, excerpts and very large reports are trimmed with a
notice to keep the file below 300 KB. Review excerpts before sharing. `--open` never opens a
browser in CI or when output is redirected; `--open` requires `--html`.

## Saving results for `plan`

```sh
npx uptide check zod stripe --json > check.json
npx uptide plan --results check.json
```

[`uptide plan`](plan.md) uses the saved findings as effort estimates.

## `uptide diff`

`uptide diff <pkg> <from> <to> [--json]` compares the full public surface of two versions of
an npm package, without a repository. Tarballs, surfaces and runtime probes are cached in
`~/.cache/uptide/`.

## Exit codes

**0** no breaking change reaches your code, in everything that was analyzed; **1** breaking
changes found at your call sites; **2** bad arguments, unsupported repository, no network, or
nothing breaking was found but a dependency failed to analyze (the report still lists the
others). See [concepts](../concepts.md#exit-codes).
