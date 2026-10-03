---
"uptide": patch
---

Verification no longer touches your services: tests that need a database, cache or queue
are opt-in (`--with-services --yes`, after printing what they connect to), and by default
only unit tests run, with the integration tests counted in the report.

`fix` and `verify` work in a temporary clone, never in your checkout, with lifecycle scripts
and git hooks disabled for every command they run; the checkout is compared before and
after. `verify --push --yes` pushes new commits from the clone, fast-forward only.

The temporary clone is removed when the run is over and kept, with its path printed, only
when the run fails, with `--keep`, or when it holds commits that are nowhere else.
`uptide clean` removes kept clones older than 7 days.
