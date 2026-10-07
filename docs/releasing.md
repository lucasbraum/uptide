# Releasing

One package is published: `uptide` (`packages/cli`), with the engine bundled in.
`@uptide/core` is never published; changesets ignores it.

Releases are automatic. Nobody publishes from a laptop, and nobody runs a workflow by hand
except in an emergency.

## Day to day

Add a changeset with every user-visible change to the CLI, in the same pull request:

```sh
pnpm changeset        # pick `uptide`, patch/minor/major, one-line summary
```

The **Changeset** check fails a pull request that changes `packages/**` without one. When
nothing a user would notice changed (tests, an internal refactor), add the `no-changeset`
label instead; the check reruns when labels change. Pull requests opened by Dependabot and
by the release app are exempt (`scripts/changeset-required.mjs`).

## How a release happens

The **Release** workflow (`.github/workflows/release.yml`) runs on every push to `main`
and decides what to do from the tree (`scripts/release-plan.mjs`):

- **Changesets are pending.** It opens, or updates, the **Version Packages** pull request:
  `changeset version` bumps `packages/cli/package.json` and writes `packages/cli/CHANGELOG.md`
  (with links to each pull request, by `@changesets/changelog-github`). It also publishes a
  snapshot of `main` under the `next` dist-tag (below).
- **No changeset is pending, and npm does not have the committed version** (what merging
  the Version Packages pull request leaves): it publishes that version under `latest`, then
  creates the `vX.Y.Z` tag at the published commit and a GitHub Release whose notes are the
  version's CHANGELOG entry.
- **Otherwise** it does nothing.

So a release is: merge pull requests with changesets, then merge the Version Packages pull
request when you want to ship.

Before anything is published, the publish job checks, in order, and stops at the first
failure:

1. the run is on `main` of the public repository, and for `latest` the committed version is
   the one planned;
2. on the committed tree, at its committed version: `pnpm lint`, and no private material in
   the repository (`scripts/public-tree.mjs` with the `UPTIDE_PRIVATE_DENYLIST` secret
   required);
3. `pnpm build`, `pnpm typecheck`, `pnpm test`;
4. `pnpm smoke 22`: the packed CLI, installed in a clean container, against npm, pnpm and
   yarn fixtures;
5. only then the version to publish: the snapshot for `next` (below), the committed one for
   `latest`, which must be a plain `x.y.z`; either must not be on npm yet. A prerelease
   version makes the CLI suggest `npx uptide@next`, which is right for the snapshot and is
   why the tests run before it: they assert what a release build prints;
6. `pnpm build` again with that version (stamped clean), and the build stamp is checked clean;
7. the tarball itself (`scripts/check-pack.mjs`): `LICENSE`, `NOTICE` and
   `THIRD-PARTY-NOTICES` are in it, `repository.url` is this repository (npm provenance
   refuses a mismatch), the version is the one being released, and no file in it holds a
   private identifier;
8. the tarball, installed, suggests commands that reach it
   (`packages/cli/smoke/check-invocation.mjs`): `npx uptide@next` from a snapshot, `npx uptide`
   from a release, and its `--version` is the package's.

That same tarball is what is published, with `npm publish --provenance`. Only the
`github-release` job can write to the repository, and only after a real `latest` publish.

### `next`

On every push to `main` with pending changesets, the publish job runs
`changeset version --snapshot next` in its own checkout, which is thrown away: the version
(`x.y.z-next.<datetime>`) is never committed or pushed, and no tag or GitHub Release is made.
It goes through the same checks (the tests on the committed version, the tarball checks on
the snapshot) and is published under the `next` dist-tag. `latest` never
moves from there.

```sh
npx uptide@next --version
```

### Emergencies

If an automatic `latest` publish failed (npm was down, a flaky step), run **Release** by hand
from `main` (Actions → Release → Run workflow). By hand it only publishes the committed
version under `latest`, if npm does not have it, whatever changesets are pending. It is a
**dry run** unless you untick `dry_run`: everything up to `npm publish --dry-run`, no tag, no
release.

## One-time setup (maintainers)

### The release app

The Version Packages pull request must get CI, and a pull request opened with the workflow's
default `GITHUB_TOKEN` triggers no workflow. So it is opened by a GitHub App:

1. **Create the app.** On the `uptide-dev` organization: Settings → Developer settings →
   GitHub Apps → New GitHub App.
   - Name: **`uptide-release`**. The name decides the bot's login, `uptide-release[bot]`,
     which DCO and the changeset check exempt (`scripts/bots.mjs`); the workflow stops if
     the app is called anything else.
   - Homepage URL: `https://github.com/uptide-dev/uptide`.
   - Webhook: untick **Active**.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and
     write** (Metadata: Read-only is added automatically). Nothing else.
   - Where can this app be installed: **Only on this account**.
2. **Generate a private key** on the app's page (it downloads a `.pem` file), and note the
   **App ID** shown there.
3. **Install the app** (Install App → `uptide-dev` → Only select repositories →
   `uptide-dev/uptide`).
4. **Store them in the repository** (Settings → Secrets and variables → Actions):
   - variable **`RELEASE_APP_ID`**: the App ID;
   - secret **`RELEASE_APP_PRIVATE_KEY`**: the whole `.pem` file, header lines included.
5. **Create the label** `no-changeset` (Issues → Labels → New label).

The app's pull request gets repository secrets like any pull request from a branch of this
repository, so its private-material scan runs with the denylist (`scripts/private-material.mjs`).

### npm trusted publishing

The publish job authenticates to npm with its own OIDC identity, so no long-lived npm token
is needed:

1. On npmjs.com, as an owner of `uptide`: the package → **Settings** → **Trusted Publisher**
   → **GitHub Actions**: organization `uptide-dev`, repository `uptide`, workflow filename
   **`release.yml`**, no environment. Save.
2. Optionally, under **Publishing access**, choose "Require two-factor authentication and
   disallow tokens".
3. Delete the `NPM_TOKEN` repository secret. Until then the workflow passes it as a fallback;
   npm uses OIDC first when a trusted publisher is configured (npm 11.5.1 or later, which the
   job installs).

Provenance needs nothing more: it comes from the same OIDC identity, and requires
`repository.url` in `packages/cli/package.json` to name this repository.

## Legal assets in the tarball

Four files travel with the published package, and none of them is written by hand at
publish time:

- `LICENSE` and `NOTICE`, copied in from the repository root by
  `packages/cli/scripts/prepack.mjs` (and removed again by `postpack`);
- `README.md`, copied in the same way, because npm shows the package directory's copy;
- `THIRD-PARTY-NOTICES`, generated by `packages/cli/scripts/third-party-notices.mjs` as
  part of `pnpm build` from the bundler's record of what went into `dist`, with the full
  license text of every package in the bundle.

`prepack` refuses to pack without `THIRD-PARTY-NOTICES`, `scripts/check-pack.mjs` refuses to
publish a tarball without any of them, and `packages/cli/src/third-party-notices.test.ts`
fails if the file on disk does not match the current bundle or if a bundled package's
license is not on the allowlist. `npm pack --dry-run` in `packages/cli` lists exactly what
will ship.

## Optional telemetry capture

The release workflow embeds `UPTIDE_TELEMETRY_BUILD_KEY` from the same-named GitHub Actions
repository secret and uses `https://eu.i.posthog.com` as the build host. Without the secret,
published builds send no telemetry. Configure only a write-only project capture key after
enabling discard-client-IP and verifying automatic 90-day deletion in the EU project. See
[the telemetry deployment checklist](telemetry.md#release-configuration-maintainers). Do not
use a personal API key. This key is intentionally public in the CLI bundle; it is supplied
through the pipeline rather than committed to source.
