# Uptide

**Migrations you can merge.**

Uptide finds what a dependency upgrade breaks in your code, migrates it, and proves it with
your compiler and tests. TypeScript repositories; verified migrations for **zod 3 → 4** and
**stripe** today.

## Quickstart (30 seconds)

No account, no config. In your repository, with dependencies installed:

```sh
npx uptide check                         # which of your lines the upgrade breaks
npx uptide fix --only zod                # migrate on a new branch, verified; nothing is pushed
npx uptide pr --branch uptide/zod-4.6.5   # prints the plan; add --yes to push and open the PR
```

`npx uptide ` alone shows where zod and stripe stand: installed, latest, majors behind.
Requires Node 20 or newer. Works with npm, pnpm and Yarn (node-modules linker).

## Before and after

[`fixtures/repos/storefront`](fixtures/repos/storefront) is a small pnpm workspace in this
repository, written to exercise Uptide: two packages on zod 3 and stripe 14, with a few
tests. Everything below is real output from it.

**Before: `check`.** What breaks, where, and who can fix it:

```console
$ npx uptide check
uptide check · storefront (pnpm, 2 packages) · 8.3s

zod                    3.25.76 → 4.6.5    major · latest on npm   ✗ 28 breaking in 7 files    24 by rule · 4 by agent
stripe (packages/api)  14.25.0 → 23.0.0   major · latest on npm   ✗ 4 breaking in 3 files     1 by rule · 3 by agent

zod
  ✗ New error API (required_error → error)   24 sites          by rule
  ✗ ZodTypeDef removed                       1 fix, 3 errors   by agent
  ✗ .ip() removed                            monitoring.ts:6   by agent
  ! 15 deprecated calls (.uuid, .datetime, .email, ...)   8 by rule

stripe
  ✗ Test fixture casts widened                   renewal.test.ts:7   by rule
  ✗ Subscription billing period moved to items   2 sites             by agent
  ✗ apiVersion no longer matches the SDK         client.ts:9         by agent
    1 API change since 2023-10-16 affects your code

Next
  npx uptide fix --only zod       migrate on a new branch, verify, no push
  npx uptide fix --only stripe    migrate on a new branch, verify, no push
  npx uptide check --details      every site and reason
```

**After: `fix`**, one dependency at a time, each on its own verified branch:

```console
$ npx uptide fix --only zod
uptide fix · zod 3.25.76 → 4.6.5 (latest on npm) · verification passed · 36s

  Risk      Medium: request validation in webhooks
  Changes   29 sites in 8 files · 25 by rule · 4 by agent
  Types     ✅ 29 errors after the bump → 1 (1 pre-existing)
  Behavior  ✅ 9 schemas identical · 2 not checked · 21/21 custom-message assertions
  Tests     ✅ 5 tests in 3 files passed
```

No compiler sees this one: zod 4 words its default messages differently, and a test that
asserted the old wording failed after the migration. Uptide updated it and says so in the
pull request, so you can check that nothing else reads that text:

```diff
-    expect(parsed.error?.issues[0]?.message).toBe('Required');
+    expect(parsed.error?.issues[0]?.message).toBe('Invalid input: expected string, received undefined');
```

```console
$ npx uptide fix --only stripe
uptide fix · stripe 14.25.0 → 23.0.0 (latest on npm) · verification passed · 41s

  Risk      High: behavior changes
  Changes   6 sites in 3 files · 3 by rule · 3 by agent
  Types     ✅ 5 errors after the bump → 1 (1 pre-existing)
  Behavior  ⚠️ 1 of 570 API changes affects your code · 47 touch resources you use (8 breaking)
  Tests     ✅ 3 tests in 2 files passed · the test script of packages/api
```

Stripe moved a subscription's billing period from the subscription to its items. Uptide
added a `subscriptionPeriod` helper and migrated the code that read the old fields:

```diff
-    renewsAt: new Date(subscription.current_period_end * 1000),
+    renewsAt: new Date(period.end * 1000),
```

The risk is High on purpose: types and tests pass, but a new API version changes what
Stripe sends, and the pull request asks what only you can answer (which item's period
counts when a subscription has several).

The one type error left in both runs is the fixture's own, there on purpose: errors a
repository already had are subtracted, never blamed on the upgrade.

## What is supported

| Tier | Dependencies | What you get |
| --- | --- | --- |
| **Verified** | zod 3 → 4, stripe 14 and newer | `check` with a migration plan per change, `fix` with rules written for that dependency, behavior checks (zod schemas compared on generated inputs; Stripe changelog filtered to what you call), a reviewed pull request body |
| **Generic** | any other dependency, with `--only <package>` | `check` only: the API diff between the two versions, your usages of what changed, and the compiler's errors against the target. No migrations. |

Verified means a migration pack exists: rules, a guide for the assisted fixer, and ground
truth from a real upgrade that the pack is scored against. Generic is the same analysis
without that knowledge; it is frozen while the packs mature
([decision](docs/decisions/0010-check-freeze.md)), and generic *migrations* are planned,
not shipped.

- **Languages:** TypeScript, and JavaScript the compiler can see (`allowJs`).
- **Package managers:** `check` on npm, pnpm (workspaces and catalogs), Yarn classic and
  bun (text lockfile); `fix` on npm (lockfile v2/v3), pnpm, and Yarn classic/Berry with the
  node-modules linker.
- **Not supported:** Yarn Plug'n'Play, bun's binary lockfile, Deno.

## How verification works

`fix` never works in your checkout. It clones your repository into a temporary directory
and, there:

1. **Baseline.** Type-checks and notes the errors you already have.
2. **Upgrades.** Bumps the version everywhere it is declared. Your package manager
   produces the lockfile, with lifecycle scripts disabled; a lockfile change outside the
   upgraded dependency's subtree is rejected.
3. **Rule-based fixes.** Deterministic rewrites, only at the sites `check` reported.
4. **Assisted fixes (optional).** Sites no rule covers go to the LLM one at a time. A patch
   is kept only if it removes its compiler error, introduces none, and passes the pack's
   own validator; otherwise it is reverted and the site is left for you.
5. **Verifies.** Type-checks with *your* TypeScript and subtracts the baseline; runs the
   tests related to the files it touched; formats and lints only those files with your
   tools. Tests that need a database, cache or queue do not run unless you ask
   (`--with-services --yes`), and the report counts what was left out.

The exit code is 0 only if no new type error remains and the tests pass. You get the branch
as a ref in your repository and the run stored in `.git/uptide/`; your branch, files, hooks
and git config are compared before and after and must be identical. Nothing is pushed
until you run `uptide pr` or pass `--pr --yes`.

Passing compilation does not prove runtime equivalence. The report says what was verified,
what was not, and what to review; server API changes (Stripe API versions) are never
rewritten by rule.

## Privacy

Analysis runs locally. Your code is sent only to the LLM provider (Anthropic), only
for assisted fixes in `uptide fix`, and only with your own ANTHROPIC_API_KEY: for each
site the rules cannot migrate, the finding, the enclosing function and the compiler
error. `uptide fix --no-llm` turns assisted fixes off. No telemetry, no account.
Other network use: your npm registry for package metadata and tarballs, and GitHub
only when you pass `fix --pr` or run `pr-body`.

There is no Uptide server. In a table:

| | Where it runs | What leaves your machine |
| --- | --- | --- |
| `check` | locally | nothing of yours; it downloads package tarballs from your npm registry. No LLM call, and nothing in your repository is executed. |
| `fix`, rules and verification | locally, in a temporary clone | nothing of yours |
| `fix`, assisted fixes | Anthropic's API, with **your** `ANTHROPIC_API_KEY` | per site no rule covers: the finding, the enclosing function or declaration, and the compiler error |
| `pr`, `fix --pr` | GitHub, through your own `gh` | the branch and the pull request, when you say so |

Without a key, or with `--no-llm`, those sites are listed for you instead. The full model, and how to report a problem, is in
[SECURITY.md](SECURITY.md).

## Exit codes

For scripts and CI: **0** nothing breaking, **1** breaking changes found,
**2** uptide could not answer (bad arguments, unsupported repository, no network). When
it cannot answer, it says why and prints the exact command to run next.

## Documentation

- [CLI reference](docs/cli.md): flags, the HTML report, each step of `fix`, pull request
  descriptions
- [GitHub Action](docs/github-action.md): check and migrate Renovate and Dependabot pull
  requests
- [Architecture](docs/architecture.md) and [decisions](docs/decisions/): how it works and why
- [Security](SECURITY.md): the isolation model
- [Contributing](CONTRIBUTING.md): setup, tests, how migration packs work
- [Development](docs/development.md) and [releasing](docs/releasing.md)

## License

[MIT](LICENSE).
