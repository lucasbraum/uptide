---
title: Getting started
description: Run Uptide on a TypeScript repository in four commands, with nothing installed and no account.
---

# Getting started

For someone running Uptide for the first time: what to run, in what order, and what the
repository needs.

## Requirements

- Node 20 or newer.
- A TypeScript repository, or JavaScript the compiler can see (`allowJs`), with a lockfile.
- A package manager Uptide supports: `check` works on npm, pnpm (workspaces and catalogs),
  Yarn classic and bun (text lockfile); `fix` works on npm (lockfile v2/v3), pnpm, and Yarn
  classic/Berry with the node-modules linker. Yarn Plug'n'Play, bun's binary lockfile and
  Deno are not supported ([troubleshooting](troubleshooting.md)).
- Installed dependencies for `check` and `fix` (`list` needs none).

No account, no config file, no API key for anything but assisted fixes.

## The four commands

In your repository:

```sh
npx uptide list                            # fast discovery; no install or compilation
npx uptide check zod                       # analyze one or more named dependencies (install first)
npx uptide fix zod                         # migrate on a new branch, verified; nothing is pushed
npx uptide pr --branch uptide/zod-4.6.5    # prints the plan; add --yes to push and open the PR
```

`npx uptide` with no command shows where zod and stripe stand in the repository: installed,
latest, majors behind.

1. **`list`** reads manifests, lockfiles, source imports and registry metadata, and says what
   to upgrade first and why. It compiles nothing and installs nothing.
   [Details](commands/list.md).
2. **`check <package>`** compiles your code against the target version and reports what
   breaks, where, and who can fix it (a rule, the agent, or you). Breaking means the compiler,
   the runtime probe or a migration pack confirmed it ([concepts](concepts.md)).
   [Details](commands/check.md).
3. **`fix <package>`** upgrades one dependency on a new branch in a temporary clone, migrates
   the code, and verifies with your TypeScript and your tests. Nothing is pushed.
   [Details](commands/fix.md).
4. **`pr`** pushes a finished branch and opens its pull request with the stored report, only
   with `--yes`. [Details](commands/pr.md).

Between `check` and `fix`, `plan` gives the order to upgrade several dependencies in
([details](commands/plan.md)).

## A real run

[`fixtures/repos/storefront`](../fixtures/repos/storefront) is a small pnpm workspace in the
Uptide repository, written to exercise it: two packages on zod 3 and stripe 14, with a few
tests. The README shows its `check zod` and `fix zod` output; the `check` and `fix` pages show
stripe. Everything in those samples is real output from that fixture.

The one type error left after each `fix` run is the fixture's own, there on purpose: errors a
repository already had are subtracted, never blamed on the upgrade.

## Assisted fixes

Sites no rule covers go to an LLM, one at a time, with your own API key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`). Without a key, or with
`--no-llm`, those sites are listed for you instead. Which provider and model, and what it
costs: [models](models.md). What is sent: [privacy](privacy.md).

## What gets installed

`npx uptide` runs the published `uptide` package. It is one bundle: it inlines its
dependencies. The notice for every package in that bundle, with the full text of its license,
ships in the npm package as `THIRD-PARTY-NOTICES` and is generated from the bundle itself at
build time. Releases up to and including 0.3.0 were published under the MIT license; 0.4.0
and later are Apache-2.0.

## In CI

The GitHub Action checks and migrates Renovate and Dependabot pull requests: [CI](ci.md).
