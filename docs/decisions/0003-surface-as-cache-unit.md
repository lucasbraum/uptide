# 0003: The extracted surface is the unit of caching

Status: accepted (2026-09-27)

## Context

A diff needs two surfaces. Extraction takes under a second for most packages and about
three seconds for stripe, after a download that dominates on a slow network. Tarballs
could be cached alone, but every diff of `stripe@14.25.0` against a new version would
re-extract the same 24,000 symbols.

## Decision

Cache both: tarballs by name and version, and `ApiSurface` JSON by package, version,
adapter id and `SURFACE_SCHEMA_VERSION`, behind the `SurfaceCache` interface. The
filesystem implementation lives in `~/.cache/uptide/`. The engine only sees the interface,
so a shared remote cache later does not touch `diffSurfaces` or the adapter.

## Consequences

- Extraction rules can change freely; bumping the schema version invalidates every cached
  surface at once. This happened five times during milestone 1 and twice it hid a change
  until the bump was made, which is why the constant is documented next to the rules.
- A surface is a few megabytes for large packages and self-contained, so a remote cache
  is a plain key-value store.
- Extracted package directories are temporary and removed after extraction; the surface
  is the durable artifact.
