# A generic tier next to the verified packs

Status: accepted, 2026-10-03. Supersedes the freeze of general analysis in 0010 for what
is listed here; 0011 (verified packs) stands unchanged.

`check` with no `--only` used to mean zod and stripe. It now means every direct dependency
that is behind, because a tool that answers for two packages cannot plan an upgrade. Two
tiers keep the promise honest:

- **Verified**: a pack covers the upgrade. Nothing about it changed.
- **Generic**: no pack. The declaration diff over-reports (a changed signature the code
  never exercises), so a finding is called breaking only with evidence beyond the diff: the
  repository's own program fails against the target at that site, the runtime probe shows
  the export gone, a `require()` meets an ESM-only target, or an import names a removed
  export. Everything else is kept as `unverified` for `--details`.

Consequences accepted:

- With `--no-compile`, or where the compile check is skipped, the generic tier calls
  nothing breaking. That is the point: no evidence, no claim.
- The whole-repository check is bounded by time (`--max-time`, default 60 s), not by a
  list. Dependencies are ranked (majors first, then by importing files) and what the budget
  does not reach is listed with the command that includes it. One dependency failing is
  one answer missing.
- `fix` for a generic dependency is the agent alone under the existing loop: one site, one
  patch, kept only if the site's compiler error disappears and none appears. No rules means
  no fix without a key, a cost limit by default, and a pull request that says no pack
  covers the package.

Evaluation on three public applications found two classes of false generic findings, both
from how the target is compiled rather than from the tier rule, and both fixed with tests:

- An untyped dependency of the target is typed by the `@types` package the target declares
  next to it; that package has to be linked too, or an ambient namespace goes missing.
- A peer dependency is the consumer's copy, as an install leaves it. Fetching the version
  the peer range asks for compiles two copies of the peer's types against each other.

A known limit stays: the compile check uses the TypeScript bundled with Uptide. For
diagnostics that are resource limits (TS2589, instantiation depth), the site that reports
the error can differ from the repository's own compiler.
