# 0009: The target's dependencies at the versions it declares

Status: accepted (2026-09-28)

## Context

Signal B type-checks the consumer with one package redirected to its target tarball. A
tarball has no `node_modules`, so the first design resolved the target's own imports from
the consumer's installed packages. On a real monorepo that produced errors that were not
the consumer's: vitest@5 type-checked against the consumer's `@vitest/*@4`, and every
error inside those declarations looked like an upgrade problem.

Pre-fetching the target's declared dependency graph fixes that and costs too much: a
package's runtime graph (drizzle-orm: 65 packages, most of them optional peers) is far
larger than what its declaration files import (4).

## Decision

Resolve on demand, from what the declarations actually import. The overlay compile
reports every bare import met inside the target, or inside anything already linked for
it, whose importer declares a range. The consumer's installed copy stands in when it
satisfies that range. Otherwise the highest published version inside the range is fetched
(an exact pin needs no version list) and linked next to the target, and the compile runs
again, until nothing new is wanted (at most five rounds). Packages in the importer's own
scope (`@scope/*` for `@scope/x`, `@x/*` for `x`) never use the consumer's copy: they
release in lockstep, and "satisfies a loose range" is not "the version this build was
made with".

Protocol specifiers (`workspace:`, `catalog:`, `npm:`) are not ranges and keep the
consumer's copy. What nobody can serve is counted as unresolved, never turned into a
finding.

Registry answers and extractions are cached on disk: an exact version's manifest for
good, dist-tags and version lists for an hour, tarballs verified on every use, extracted
directories reused. A run asks each question once; the next run an hour later asks it
of the disk.

## Consequences

- The consumer's `node_modules` is read, never written; linking happens in a temp overlay.
- A wrong-version dependency of the target can no longer masquerade as a consumer error.
- Only declaration-reachable dependencies are fetched, so the network cost is bounded by
  the types, not by the package's runtime graph.
- The semver subset implemented (`src/fetch/range.ts`) covers what manifests use in
  practice: exact, `^`, `~`, comparators, hyphen ranges, wildcards and `||`.
