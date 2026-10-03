# 0005: No database, no service in milestone 1

Status: accepted (2026-09-27)

## Context

A shared store of surfaces and diffs is an obvious product feature: most users will ask
about the same popular package pairs. It is also a server, an account system and an
operational burden, none of which help measure whether the diff engine is precise.

## Decision

Everything is local files. Tarballs and surfaces live in `~/.cache/uptide/` behind the
`PackageFetcher` and `SurfaceCache` interfaces. The npm registry is the only network
dependency. There is no telemetry and no user code anywhere in this milestone.

## Consequences

- The engine is a pure function of two surfaces; tests stub the two interfaces with
  in-memory versions and the whole suite runs offline in about a second.
- A remote cache can be added as another `SurfaceCache` implementation without touching
  `diffSurfaces`, the adapter or the CLI.
- Real-pair snapshot tests are gated behind `UPTIDE_NETWORK=1` and store a digest, not the
  full `Change[]`, because the full form runs to 19MB for eight pairs.
