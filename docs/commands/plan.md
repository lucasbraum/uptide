---
title: uptide plan
description: The order to upgrade several dependencies in, with the effort each one takes, from discovery and saved check results.
---

# `uptide plan`

For someone with several upgrades ahead who wants to know which to do first, and what each
costs. `uptide plan --help` lists the flags.

`uptide plan` uses discovery, with **unknown** effort until a matching check result is
supplied:

```sh
npx uptide check zod stripe --json > check.json
npx uptide plan --results check.json
```

Discovery plus optional saved check results, never implicit deep analysis: `plan` never
compiles every dependency or downloads tarballs. Takes `--only`, `--json`, `--html`.

Unchecked or partially checked packages have unknown effort and suggest `uptide check <pkg>`.
Matching complete check results supply estimates: none, small, medium or large. Saved
results must match the repository, versions and workspaces; rerun `check` after source
changes. Peer ranges from registry metadata and installed manifests constrain the order; a
range nothing satisfies is named as blocked, and unavailable metadata is disclosed. Without
`node_modules`, installed-peer constraints cannot be read.

Exit codes: **0** a plan was made, **2** discovery incomplete or a dependency failed to
analyze (the plan still orders the others). See [concepts](../concepts.md#exit-codes).
