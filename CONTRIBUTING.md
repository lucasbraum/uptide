# Contributing to Uptide

Thanks for helping. Uptide checks what a dependency upgrade breaks in a TypeScript
repository and migrates the code on a branch it has verified. Contributions that make a
migration more correct, or that show one being wrong, are the most valuable.

## Setup

Node 20 or newer and pnpm (the version in `packageManager`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build          # core, then the CLI that bundles it
pnpm test           # offline: no network, no API key
pnpm lint           # biome; `pnpm format` fixes formatting
pnpm typecheck
```

`pnpm build` also regenerates the notices for everything the CLI bundles
(`packages/cli/scripts/third-party-notices.mjs`). It fails the build if a bundled package
has no license text or a license outside the allowlist, so adding a dependency that the
project cannot ship is caught there rather than at publish time.

Run the CLI you just built against any repository:

```sh
node packages/cli/dist/index.js list --cwd /path/to/repo
node packages/cli/dist/index.js check zod --cwd /path/to/repo
```

Other suites, when your change touches them:

| Command | What it proves | Needs |
| --- | --- | --- |
| `UPTIDE_NETWORK=1 pnpm test` | real package digests, the Stripe `tsc` fixture | npm registry |
| `pnpm smoke 20` / `pnpm smoke 22` | the packed CLI on npm, pnpm and Yarn fixtures | Docker |
| `pnpm eval:check fixtures/repos/storefront --truth=fixtures/truth/storefront.json` | check against the errors a real upgrade produced | the fixture's dependencies (`pnpm install --ignore-scripts` in it) |

## Layout

- `packages/core`: the engine. `check/` finds what an upgrade breaks, `fix/` runs and
  verifies a migration, `packs/` holds what Uptide knows about one dependency.
- `packages/cli`: the `uptide` command, its terminal and HTML output. It is the only
  published package and bundles the engine.
- `docs/architecture.md` and `docs/decisions/` explain why things are the way they are.
  Read the decision that covers the area you are changing.

## Fixtures are pinned on purpose

`fixtures/` is test data: repositories at old, sometimes vulnerable, versions, because that
is what Uptide upgrades. Dependabot leaves it alone (`exclude-paths` in
`.github/dependabot.yml`), for version and security updates alike. GitHub still raises
Dependabot alerts for those manifests; dismiss them as “Vulnerable code is not actually used”.
Never update a fixture to silence an alert: a fixture changes only together with the tests
that rely on it.

CI's private-material check scans for private identifiers from the `UPTIDE_PRIVATE_DENYLIST`
secret. GitHub gives Dependabot's pull requests no repository secrets, and this one is
deliberately **not** added to the Dependabot secrets: a dependency bump is exactly the code
nobody has reviewed yet, and dependency code runs in that job before the check (the linter
from `node_modules`, and install scripts if they are ever enabled) and can reach the steps after
it (`$GITHUB_ENV`), so it could read the list. On a pull request opened by `dependabot[bot]`
the identifier scan is skipped with a notice; document names are still checked, and the merge
to `main` is scanned with the secret. Any other pull request from this repository without the
secret fails. The release app's Version Packages pull request gets the secret like any other
from this repository, so it is scanned in full. Which scan runs when:
`scripts/private-material.mjs`.

## How packs work

A migration pack (`packages/core/src/packs/<dependency>/`) owns the knowledge of one
dependency; the runner owns everything else (install, verification, commits, publishing).
The contract is `MigrationPack` in `packages/core/src/packs/types.ts`. A pack provides:

- **rules**: deterministic rewrites, applied only at sites `check` reported;
- **a guide** for assisted fixes, and a validator that can reject a patch the compiler
  would accept (a fallback like `?? 0` that hides a missing value, for example);
- **findings the compiler cannot see** (a Stripe client without `apiVersion`);
- **review material**: decisions that are the user's to make, changelog entries filtered to
  what the code uses, test follow-ups.

Rules for a pack change:

1. A rule never edits a site that was not reported, and never changes behavior silently.
   When behavior can differ, the report says so and asks.
2. Every rule has a test with the code before and after, and a case it must leave alone.
3. A claim about what a pack finds is backed by ground truth in `fixtures/truth/`: the
   compiler errors a real upgrade produced on a fixture in this repository. No private
   code, paths or names anywhere in the tree: fixtures are synthetic.
4. Server API changes (Stripe API versions) are never rewritten by rule.

## Rules that do not bend

These are what make Uptide safe to run on someone else's code. A pull request that breaks
one is not merged, whatever else it does.

- `check` makes no LLM call and executes nothing from the repository it reads.
- Dependencies are installed with lifecycle scripts disabled; third-party code is never run
  outside the designed verification step of `fix`.
- `fix` and `verify` work in a temporary clone. The user's checkout, services, git config
  and hooks are never touched, and nothing outside Uptide's own temporary directory is
  deleted.
- Code leaves the machine only for assisted fixes, with the user's own API key, and
  `--no-llm` turns that off. Anonymous telemetry requires opt-in and the strict field allowlist in
  `docs/telemetry.md`; never add source, paths, repo/user names, or unproven package names.
  No account or Uptide server.
- Nothing is pushed or published without an explicit flag from the user.

## Pull requests

- One change per pull request, with tests. A bug fix starts with a test that fails.
- Small files and pure functions; comments say why, not what.
- Ask in an issue before adding a dependency.
- Keep the README honest: if behavior changes, the README changes in the same pull request
  (`packages/cli/src/readme.test.ts` checks its flags and examples against the CLI).
- Add a changeset for anything a user would notice: `pnpm changeset`. The **Changeset**
  check fails a pull request that changes `packages/**` without one; when nothing a user
  would notice changed (tests, an internal refactor), add the `no-changeset` label instead.
- `pnpm lint && pnpm typecheck && pnpm test` pass before you ask for review.
- Commit messages follow `type(scope): what changed`, as in `git log`, and every commit is
  signed off (see below).

## How releases work

You do not release anything by hand. Every push to `main` runs the **Release** workflow:

- while changesets are pending, it keeps a **Version Packages** pull request open (the next
  version and its CHANGELOG entry) and publishes a snapshot of `main` under the `next`
  dist-tag (`npx uptide@next`);
- merging the Version Packages pull request publishes that version under `latest`, with npm
  provenance, after the full test suite, the packed-CLI smoke test and the tarball checks,
  then tags it and creates its GitHub Release from the CHANGELOG.

Your part is the changeset in your pull request. The details, the emergency dry run and the
one-time setup are in [docs/releasing.md](docs/releasing.md).

## Sign off your commits (DCO)

Uptide uses the [Developer Certificate of Origin](https://developercertificate.org/). It is
one line in each commit message saying you wrote the patch or have the right to send it:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it from your `user.name` and `user.email`, so set those once and then
commit as usual:

```sh
git config user.name "Your Name"
git config user.email "you@example.com"
git commit -s -m "fix(check): what changed"
```

Every commit in a pull request needs the line, not just the last one. If you forgot, add it
to the commits you already made and force-push your branch:

```sh
git rebase --signoff origin/main   # or: git rebase --signoff -i HEAD~3
git push --force-with-lease
```

The `DCO` workflow checks every commit in the pull request and names the ones that are
missing it, with that command in the failure message. Bots that cannot sign off
(`dependabot[bot]`, `github-actions[bot]`, and `uptide-release[bot]`, the app that opens the
Version Packages pull request; see `scripts/bots.mjs`) are exempt for the commits they author
in the pull requests they open; a person's commit pushed to such a pull request still needs
the line.

By contributing you agree that your contribution is licensed under the
[Apache License, Version 2.0](LICENSE), the same license Uptide is released under: what
comes in is what goes out. Sign-off is how you state that; no separate CLA is involved.
Releases up to and including 0.3.0 were published under the MIT license.
Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](SECURITY.md), not public issues.

Provider adapter tests replay synthetic protocol fixtures with mocked HTTPS; CI must never call a live LLM. Update dated pricing and the telemetry model allowlist together. Run live storefront comparisons only with environment keys, never record keys or customer source in fixtures.
