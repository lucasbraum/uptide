# Discovery before analysis

Status: accepted, 2026-10-03. Supersedes the whole-repository budgeted CLI behavior in 0012.

`list` reads direct declarations, locked versions, source syntax and registry metadata.
It never creates a TypeScript program, installs dependencies, or downloads tarballs.
Ranking is deterministic: majors, importing files, direct call sites, name, current version.
Usage is a syntactic estimate, not the type-aware analysis that check performs.

`check` requires explicit package names. The `--only` spelling remains a compatibility
alias; `all` and `--max-time` are removed from the CLI. Per-package tiers, evidence rules
and partial results are unchanged. `fix` accepts one positional name, retaining its alias.

`plan` uses discovery and optional explicitly supplied check JSON. No persisted source
cache is created implicitly. It rejects a report for a different repository and uses
only matching versions/workspaces; consumers must rerun check after editing their source.
Unknown effort never means safe. Peer metadata comes from the registry, not tarballs.

Analysis workers reserve at most about 60% of OS-available memory including estimated
native overhead. Named checks load only importing workspaces; baseline and target programs start
from the importers and follow their imports. Cache keys include the roots. Memory estimates use
that resolved graph (including ambient types and workspace source mappings), weighted for source,
declaration and per-root checker costs. Calibration uses actual peak process RSS on public repos.
Concurrency is capped by CPU count, active workspaces and memory; a single workspace receives the
full reservation. Parallel memory failures are retried serially after all other programs release
memory. Skipping is reserved for a scoped program that cannot fit alone, with the workspace,
estimate and available memory reported. Estimates cannot guarantee RSS; failures remain partial
results. User overrides cannot exceed the budget. Every importing root receives baseline/target
diagnostics, even when an unused or JSX binding has no attributed API usage.
