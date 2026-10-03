# 0008: The lockfile is the source of installed versions

Status: accepted (2026-09-28)

## Context

`check` compares what a repository has against what it could have. "What it has" could be
read from `node_modules/<pkg>/package.json`, which is fast and always exact, but it
describes one machine's install, not the project: a stale or partial install, a linked
checkout, a different workspace's hoisted copy.

## Decision

Installed versions come from the lockfile: pnpm (v5 and v6+), npm (v1 and v2/v3), yarn
(v1 and berry) and bun's text lockfile, reading the importer of the package being checked
even when the lockfile sits at a workspace root. `node_modules` is used for what it is
good at: the compiler resolves the package through it (following pnpm's symlinked store),
and the installed API surface is extracted from that directory, never fetched.

## Consequences

- A repository without a lockfile has no installed versions and nothing to check; the
  report says so rather than guessing from `node_modules`.
- Dependencies never imported by the repository, and `@types/*`, are reported as
  `not-imported` and not fetched; `--all-deps` includes them.
- The binary `bun.lockb` is not read.
