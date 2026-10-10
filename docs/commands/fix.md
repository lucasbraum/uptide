---
title: uptide fix
description: Upgrade one dependency on a new branch in a temporary clone, migrate the code by rule and by agent, and verify with your compiler and tests; verify and clean.
---

# `uptide fix`, `uptide verify` and `uptide clean`

For someone ready to let Uptide migrate a dependency, who wants to know exactly what it
touches and how it proves the result. `uptide fix --help` lists the flags.

## What a run looks like

Real output from [`fixtures/repos/storefront`](../../fixtures/repos/storefront), the public
fixture in the Uptide repository, one dependency at a time, each on its own verified branch:

```console
$ npx uptide fix zod
uptide fix · zod 3.25.76 → 4.6.5 (latest on npm) · verification passed · 36s

  Risk      Medium: request validation in webhooks
  Changes   29 sites in 8 files · 25 auto-fixed · 4 fixed by the agent (LLM)
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
$ npx uptide fix stripe
uptide fix · stripe 14.25.0 → 23.0.0 (latest on npm) · verification passed · 41s

  Risk      High: behavior changes
  Changes   6 sites in 3 files · 3 auto-fixed · 3 fixed by the agent (LLM)
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

The risk is High on purpose: types and tests pass, but a new API version changes what Stripe
sends, and the pull request asks what only you can answer (which item's period counts when a
subscription has several).

The one type error left in both runs is the fixture's own, there on purpose: errors a
repository already had are subtracted, never blamed on the upgrade.

## Peer planning and the baseline lockfile

Before cloning, `fix` checks the installed direct dependencies' peer ranges against the
upgrade and its lockstep companions, using the same conflict rule as `check`. For each
conflict it looks for the **lowest newer stable release** declaring a compatible peer range.
It reports all conflicts together, including already allowed peers, and looks ahead through
proposed peer upgrades and their lockstep companions. It ends with one full command containing
all proposed extras, required `--allow-peer` flags, the resolved target and `--no-llm` when set.
Every package the list says to add appears in that command, even when another extra would
already bring it along as a companion. Each package has one row listing all rejected peers.
With `--json`, both a blocked preflight and the completed fix report expose `peerConflicts`
with one entry per package and a `peers` array retaining every range, target and inspected
version; a blocked preflight also includes `next` and exits 2.
It never adds an unrequested peer upgrade silently:

```sh
npx uptide fix react some-react-plugin --no-llm
```

The extra names must be peer upgrades suggested by the plan. They move in the same install
and commit, and appear under companions in the report. Review their own API changes too.

With npm, an unresolved peer conflict stops with exit **2**, before cloning, installing,
creating a branch or calling the LLM. If there is no compatible release, explicitly accept
that package's compatibility risk with repeatable `--allow-peer`:

```sh
npx uptide fix react --no-llm --allow-peer @emoji-mart/react
npx uptide fix react --allow-peer plugin-a --allow-peer plugin-b
```

The override is committed in the root `package.json`: npm `overrides` scoped to that package,
pnpm `pnpm.peerDependencyRules.allowedVersions` with a `package>peer` selector, or Yarn
`resolutions` with a `package/peer` selector. Existing unrelated configuration is preserved.
The PR's **Peer risks** lists every conflict, the original peer range and whether you allowed
it. An override permits dependency resolution; it does not establish runtime compatibility.
Uptide never adds `--legacy-peer-deps` or `--force`.

For pnpm and Yarn, conflicts are reported but do not stop planning. Their own settings may
still reject the install (for example strict peer checking). `--allow-peer` writes the native
setting when requested; Yarn resolutions select a version but may still leave peer warnings.

For npm, Uptide also compares the committed root and workspace declarations with their
lockfile importers and locked direct versions. If they disagree it exits **2** before cloning:
`the lockfile does not match package.json; run npm install first`. This is a read-only check;
it does not normalize the lockfile. The scope guard unions the resolved subtrees of the
leader, companions, explicit extras and allowed-peer overrides in both lockfiles. Outside
that union, package names, versions and integrity must resolve identically for every dependent.
For npm this follows Node's lookup from each placement up through `node_modules`; pnpm and
Yarn use their locked dependency references. Unchanged dependent records are checked too.

npm may also re-resolve an existing package that peers on a planned package. Uptide admits
that package only when its new version stays in the same major, is newer, and satisfies every
previously declared consumer range. Its subtree may change, but unchanged outside consumers
must retain their transitive resolutions. The report and PR list these packages and ranges
under **Re-resolved because a peer changed**. This exception is npm-only; it does not rewrite
their manifest ranges or silently add them to the explicit upgrade plan.

Same-content deduplication and descriptive metadata changes (such as `license`) are accepted.
An outside package disappearing from the resolved graph, a changed resolution, or changes to
execution/platform fields (`scripts`, `bin`, `os`, `cpu`) still stop the install. Importer
ranges remain protected except for packages actually upgraded. When an integrity hash is
absent, the source locator must remain unchanged too.

Accepted changes appear under a collapsed **Lockfile housekeeping** section in the PR body
and HTML report, with dedupe and metadata counts and the affected lockfile placements. The
terminal shows counts; the stored JSON retains the full list.

## Step by step

`fix` never works in your checkout. Everything happens in a temporary clone of your
repository, and there:

1. **Starts from your local commit.** The clone is made from your local repository at the
   commit you have checked out, never from the remote. Uncommitted changes are left out and
   listed. A branch that is ahead of or behind its upstream is migrated as it is, with one
   line saying so. With `--pr` the run stops before any work when the base branch on `origin`
   does not contain that commit (push it first, or pass `--base <branch>`), and when the
   working tree has uncommitted changes (commit them, or pass `--allow-dirty`): the PR must
   hold the migration and nothing else. A commit that is behind the base only gets a
   warning. The remote is compared as last fetched: run `git fetch origin` if you pushed
   from elsewhere. It works on a new branch `uptide/<package>-<version>`. Nothing is pushed
   unless you pass `--pr --yes`, or later run `uptide pr --branch <branch> --yes`
   ([`uptide pr`](pr.md)).
2. **Baseline.** Type-checks and notes the errors you already have.
3. **Upgrades.** Bumps the version in every workspace that declares it (and in pnpm
   catalogs), preserving `^`, `~`, or exact ranges. Installs run in a temporary git worktree
   with lifecycle scripts disabled. The real package manager produces the lockfile; Uptide
   rejects changes outside the target dependency subtree before copying it back unchanged.
   One commit. Packages that must move with it move in the same install and commit, each at
   the version that agrees with the target (see "Companions" in
   [architecture](../architecture.md#companions)): `fix ai` also bumps `@ai-sdk/react`,
   `@ai-sdk/provider` and every installed `@ai-sdk/*` provider, and `check`'s plan, the
   summary (`With`) and the PR description say which and why. When one of them has no release
   that agrees, `fix` stops before changing anything.
4. **Rule-based fixes.** Deterministic rewrites for the changes it has rules for, only at
   the sites `check` reported, such as zod's `required_error` / `invalid_type_error` (add
   `--include-deprecated` for `z.string().email()`-style chains). One commit.
5. **Assisted fixes (optional; all there is for a generic package).** With the selected
   provider's API key set, sites the rules cannot migrate go to the LLM one at a time. A
   patch is kept only if it removes its compiler error, introduces none, and passes the
   pack's own validator; otherwise it is reverted and the site is left for you. `--no-llm`
   turns this off. Which provider and what it costs: [models](../models.md).
6. **Verifies.** Type-checks with *your* TypeScript (or the bundled compiler when absent)
   before and after and subtracts the errors you already had; runs the tests of the affected
   workspaces (each workspace's `test` script, else the vitest or jest configuration that
   covers it, scoped to the tests related to the migrated files, else the root `test`
   script) and reports what ran; by default only tests that need no database, cache or queue
   run, and the report counts the integration tests it left out (`--with-services --yes`
   includes them, after printing what they connect to); formats the files it edited, and
   only those, with your formatter and runs your lint (biome, prettier, eslint) on them,
   where a new lint failure fails verification; for zod, compares v3 and v4 behavior of
   your schemas on generated inputs.

The exit code is 0 only if no new type error remains and the tests pass. You get the branch
as a ref in your repository and the run stored in `.git/uptide/`; your branch, files, hooks
and git config are compared before and after and must be identical. Nothing is pushed until
you run `uptide pr` or pass `--pr --yes`.

Passing compilation does not prove runtime equivalence, so the report (`pr-body.md` and
`report.html` next to the stored run in `.git/uptide/<branch>/`) lists what was verified,
what was not, and what to review. Stripe API-version changes are never rewritten by rule:
they are assisted or left for you, with the relevant changelog entries and a
dashboard/webhook checklist in the report. `uptide fix stripe --pin-current-api` is the
small PR: same SDK, `apiVersion` made explicit on every client that omits it.

## A dependency without a pack

`uptide fix <any dependency>` works without a pack: there are no rules, so every site with
evidence goes to the agent, one at a time, and an edit is kept only if that site's compiler
error disappears and no new one appears. The verification and the publish gate are the same
as for a verified dependency.

- It needs the selected provider's environment API key ([models](../models.md)). Without
  one, or with `--no-llm`, it says what it cannot do and exits before creating a clone, a
  branch or an install.
- `--max-cost <usd>` (default 1) reserves the worst-case cost before every call, including
  retries. Sites not completed stay manual, the summary and the pull request say how many,
  and a run with sites left does not verify, so it cannot be published.
- The pull request opens with a note that no migration pack covers the package, and its
  risk is never Low.

## `uptide verify`

For a branch `fix` created that got new commits, or whose run predates a check you now want:

```sh
git switch uptide/zod-4.6.5 && uptide verify
```

It formats the files the migration edited, runs the related tests (fixing a test that fails
for a known behavior change), type-checks and lints, all as new commits on top, in a
temporary clone, never in your checkout. History is never rewritten; `--push --yes` pushes
the new commits from the clone, fast-forward only. The stored run then records the new HEAD,
so `uptide pr-body` can update the description. `--branch <name>` names a branch other than
the one checked out; `--with-services --yes` and `--keep` work as in `fix`. Exit codes: **0**
the branch verifies, **1** verification failed, **2** uptide could not answer.

## `uptide clean`

`fix` and `verify` keep a temporary clone when the run failed, when `--keep` was passed, or
when it holds commits that are nowhere else. `uptide clean` removes kept clones older than 7
days (`--days <n>` changes the age). Only directories Uptide created under its own temporary
root are ever removed.

## Exit codes

**0** migration verified: no new type errors, tests pass; **1** verification failed or sites
remain for manual work; **2** uptide could not answer. See [concepts](../concepts.md#exit-codes).
