---
title: Troubleshooting
description: Unsupported package-manager setups, proxies and corepack, memory limits, and what "advisories not checked" means.
---

# Troubleshooting

For anyone whose run stopped or said less than expected: what the message means and what
to do. Every command prints the exact next command when it cannot answer; this page adds
the why.

## Yarn Plug'n'Play

Not supported. `check` reads lockfiles and compiles from `node_modules`; `fix` installs with
the node-modules linker. Switch the project (or a worktree of it) to `nodeLinker:
node-modules` to run Uptide on it. `check` supports npm, pnpm (workspaces and catalogs), Yarn
classic and bun (text lockfile); `fix` supports npm (lockfile v2/v3), pnpm, and Yarn
classic/Berry with the node-modules linker. Deno is not supported.

## bun's binary lockfile

`bun.lockb` is not read; `bun.lock` (the text lockfile) is. Run `bun install --save-text-
lockfile` once (bun's own flag) so the repository has `bun.lock`, and `check` can read the
installed versions.

## Package manager not available, or the wrong version

`fix` runs the package manager the repository names in `packageManager` (corepack's choice),
else the one its lockfile implies, with lifecycle scripts disabled and corepack's network
access off, so the binary must already be there at the pinned version. A pinned Yarn 2 or
later is the exception: `fix` runs it through corepack when the `yarn` on PATH cannot (next
section). Otherwise, when the binary is missing or at another version, the run fails before
changing anything and prints the recovery command:

```sh
corepack enable pnpm && corepack prepare pnpm@<version> --activate
```

Unsupported range or lockfile syntax fails explicitly rather than silently broadening the
upgrade.

## Yarn 4 says the global Yarn is 1.x

A repository that pins Yarn 2 or later in `packageManager` (`"packageManager": "yarn@4.7.0"`)
on a machine whose `yarn` is classic 1.x, or has none, used to stop `fix` and `verify` with
Yarn's own message, "This project's package.json defines packageManager yarn@4.7.0. However
the current global version of Yarn is 1.22.22". Now `fix` and `verify` notice the mismatch
and run the pinned version through corepack (`corepack yarn install ...`, with the download
prompt off), which fetches it into corepack's own cache. Nothing on your machine is changed:
corepack is not enabled, no shim is installed, and the `packageManager` field is not
rewritten. A Berry `yarn` on PATH at the pinned version is used as it is.

When corepack itself is not available (it ships with Node 16.9 and later, and some
distributions leave it out), the run stops before cloning, with exit code 2:

```
This repository pins yarn@4.7.0 (packageManager), but the yarn on PATH is 1.22.22 and corepack is not available to run the pinned version. Nothing was cloned or installed.
Next: corepack enable
```

When corepack is there but cannot fetch the pinned version (an offline machine, a registry
it cannot reach), the message says so and names `COREPACK_NPM_REGISTRY`: set it to your npm
mirror and run again, or activate the version by hand with `corepack enable yarn && corepack
prepare yarn@4.7.0 --activate`.

## Corporate proxy and corepack registry

Target versions and their type declarations come from your npm registry. Behind a proxy, set
`HTTPS_PROXY`; a custom registry, scoped registries and credentials are read from your
`.npmrc` (environment overrides, project and user files). Credentials are never written to
the cache. Corepack downloads package managers from npm's registry on its own; behind a
mirror, corepack's `COREPACK_NPM_REGISTRY` points its `prepare` step at the mirror.

## Memory limits

Analysis concurrency uses CPU count and available memory (including reclaimable memory
reported by the OS), reserving at most about 60% for worker heaps and estimated overhead.
Named checks build their baseline and target programs from the files importing those
packages; both baseline and target start from those importers, following their imports with
the repository's compiler options. Workspaces with no such imports load no program. The
estimate counts reachable sources, declarations and importer roots, not all installed
declarations. Workspaces run serially with the full
reservation when they cannot fit in parallel; unexpected parallel memory failures get one
serial retry. Only a scoped program that cannot fit alone is skipped, with its workspace,
estimate and available budget; a skipped workspace is named under "Not analyzed" and is
never a safety verdict.

`--workspaces <n>` and `UPTIDE_WORKER_HEAP_MB` (in megabytes, at least 128) can lower the
limits, never bypass the memory cap: a worker heap is at most 8192 MB and at most what the
budget allows. Compiler allocations are estimates; unexpected worker failures still preserve
other results, and unexpected allocation failures remain isolated to the workspace.
Recursion failures name the package and give no safety verdict.

## "advisories not checked"

`list` asks npm's bulk advisory endpoint, once, for the names and installed versions of
packages served by the public npm registry. A failure or timeout (5 s) prints "advisories
not checked" in the PRIORITIES heading and never fails the run: the rest of the output is
complete. `--no-advisories`, or `"advisories": false` in `uptide.config.json`, never sends
the request, and the heading says the same.

## A dependency was not analyzed

A registry error, a tarball that cannot be fetched, or a workspace that ran out of memory
puts the dependency under "Not analyzed" with its reason; the others are reported as usual.
The exit code is then 1 if anything breaking was found, else 2, because the question was not
fully answered ([concepts](concepts.md#exit-codes)).

## Kept temporary clones

`fix` and `verify` keep their clone when the run failed, when `--keep` was passed, or when it
holds commits that are nowhere else; its path is printed. `uptide clean` removes kept clones
older than 7 days ([`uptide clean`](commands/fix.md#uptide-clean)).
