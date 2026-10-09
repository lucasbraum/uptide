---
title: FAQ
description: How Uptide relates to Renovate and Dependabot, where your code goes, what happens without a pack, and whether anything is pushed.
---

# FAQ

For anyone with the usual four questions before a first run.

## How is this different from Renovate and Dependabot?

They open the pull request that bumps the version. Uptide answers what that bump breaks in
your code (`check`), migrates the code on a branch (`fix`), and verifies the result with your
compiler and tests. The two work together: the [GitHub Action](ci.md) checks their pull
requests and, when a pack covers the upgrade, pushes the migration onto the same branch.

## Does it send my code anywhere?

`list`, `check` and `plan` send nothing of yours: package names and versions go to your npm
registry, and `list` names public packages to npm's advisory endpoint. Code leaves the
machine only for assisted fixes in `fix`, with your own API key, one site at a time (the
finding, the enclosing function or declaration, the compiler error), and `--no-llm` turns
that off. There is no account and no Uptide server. The full model: [privacy](privacy.md).

## What if no pack exists for my dependency?

`check` works the same: a generic dependency gets the same analysis, and breaking still means
the compiler, the runtime probe or the import confirmed it ([concepts](concepts.md#tiers-verified-and-generic)).
`fix` migrates with the agent alone, needs a provider API key, stops at `--max-cost`
(default $1) and opens its pull request with a note that no pack covers the package.
Packs can be written by anyone ([migration packs](packs.md)); the next ones worth writing are
in [`packs/queue.json`](../packs/queue.json).

## Does it push to my repository?

Not unless you say so. `fix` works in a temporary clone and leaves you a branch and a stored
run; nothing is pushed until you run `uptide pr --yes` or pass `fix --pr --yes`. Your
checkout, git config and hooks are compared before and after and must be identical.

## Which TypeScript does it compile with?

Your repository's own `node_modules/typescript`, found the way your build finds it, so the
errors and their lines are the ones `tsc` would print. The bundled compiler stands in only
when the repository installs none, and the [coverage line](concepts.md#the-coverage-line)
says which one judged.
