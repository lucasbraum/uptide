# 0002: Never install or run the analyzed package

Status: accepted (2026-09-27)

## Context

The engine needs a package's declaration files. `npm install` (or `pnpm add`) would
resolve them along with dependencies, but it runs lifecycle scripts of third-party code on
the user's machine, touches a project's lockfile, and pulls a dependency tree we do not
analyze. Uptide will later run in CI against arbitrary dependencies; executing them is not
acceptable.

## Decision

Resolve the version through the registry API, download the published tarball, verify its
integrity, and extract it with a hand-written ustar/pax reader that writes regular files
and directories only. Nothing in the tarball is ever executed. Dependencies are not
fetched.

## Consequences

- Imports of dependencies do not resolve. Types that come from a dependency print as
  written or as `any`; `export * from 'dep'` contributes nothing. This is visible in the
  eval (a few `next` constants print as `const any`) and is accepted for milestone 1.
  Fetching declared dependencies' tarballs the same way is a possible later extension.
- The tar reader is about 100 lines and is verified against real tarballs (zod, axios,
  the S3 client, next's 6721 files) by comparing file lists with the system `tar`.
- The per-version manifest endpoint is used before the packument: `next`'s abbreviated
  packument is 25MB, the manifest is a few kilobytes.
