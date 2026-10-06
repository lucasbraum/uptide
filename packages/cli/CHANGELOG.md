# uptide

## 0.3.0

First public release.

- First public release: `npx uptide` shows where zod and stripe stand, `uptide check` lists
  the call sites an upgrade breaks, and `uptide fix` migrates them on a verified branch.
- `uptide check` opens with one screen: a row per dependency, a line per change rule saying
  whether `fix` migrates it by rule, by agent or not at all, and the exact commands to run
  next. Progress is a single live line that disappears; `--details` lists every site, reason
  and compiler message, and `--verbose` now means one progress line per phase.
- Commands printed by the CLI and written into PR descriptions name the build that printed
  them: `npx uptide` for a stable version, `npx uptide@next` for a `next` prerelease.
- stripe: a test fixture that was already cast straight to an SDK type (`{...} as
  Stripe.Subscription`) and stops compiling after the bump is widened by rule to
  `as unknown as`, and reported as "Test fixture casts widened"; a fixture with only the old
  subscription period fields gains the item that carries them. Casts the agent adds are still
  rejected. The `subscriptionPeriod` helper is placed by rule above the doc comment of the
  function that needs it when no shared client module is in reach.
  The Tests line adds workspaces up: "5 tests in 3 files passed".
- `fix --pr` and `pr-body` share one gate: a failed verification or a run from an Uptide
  checkout with uncommitted changes is never published, and the CLI says why. Tests are
  detected the same way everywhere (workspace script, the vitest or jest config covering the
  workspace scoped to related tests, root script) and the report says what ran. A PR body
  only contains what its own run found, and a stripe body says when no API change affects
  the code.
  `fix` formats the files it edited, and only those, with the repository's formatter, and runs
  the repository's lint on them; a new lint failure fails verification. `uptide verify`
  verifies a migration branch again where it stands, adding commits and never rewriting
  history. A failing test outside the affected files is rerun once. The zod pack finds what
  depends on zod 3's default error messages and fixes the test that fails on them; the stripe
  pack makes tests follow the pinned API version.
- A registry that rate limits (HTTP 429) or is briefly down is retried with backoff, and a
  dist-tag it answered before is taken from the local cache when it cannot answer now. When
  it still fails, `check` exits 2 and says so, instead of "not analyzed" with exit 0.
  Under `Node16`/`NodeNext` module resolution, `check` now finds usages of packages that ship
  separate declarations for `import` and `require` (stripe 22 and newer); they were reported
  as not imported.
- Verification no longer touches your services: tests that need a database, cache or queue
  are opt-in (`--with-services --yes`, after printing what they connect to), and by default
  only unit tests run, with the integration tests counted in the report.
  `fix` and `verify` work in a temporary clone, never in your checkout, with lifecycle scripts
  and git hooks disabled for every command they run; the checkout is compared before and
  after. `verify --push --yes` pushes new commits from the clone, fast-forward only.
  The temporary clone is removed when the run is over and kept, with its path printed, only
  when the run fails, with `--keep`, or when it holds commits that are nowhere else.
  `uptide clean` removes kept clones older than 7 days.
