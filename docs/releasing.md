# Releasing

One package is published: `uptide` (`packages/cli`), with the engine bundled in.
`@uptide/core` is never published; changesets ignores it.

## Day to day

Add a changeset with every user-visible change to the CLI:

```sh
pnpm changeset        # pick `uptide`, patch/minor/major, one-line summary
```

## Publishing `next`

The **Release (next)** workflow (`.github/workflows/release.yml`) runs only when
triggered by hand (Actions → Release (next) → Run workflow). It:

1. installs, lints, builds, tests and runs the tarball smoke test;
2. runs `changeset version --snapshot next`, giving `x.y.z-next.<timestamp>` from the
   pending changesets (it fails if there are none); nothing is committed;
3. publishes `uptide` with `--tag next`. `latest` is not touched. npm provenance is attached
   only when this repository is public (the workflow's `UPTIDE_PROVENANCE` flag, computed
   from the repository's visibility): the registry refuses provenance from a private one.

Tick **dry_run** to do everything except the upload.

Users try it with `npx uptide@next`.

## One-time setup

- Repository secret `NPM_TOKEN`: an npm automation token allowed to publish `uptide`.
  After the first publish, npm trusted publishing can replace the token (configure the
  package on npmjs.com for this repository and workflow, then drop `NODE_AUTH_TOKEN`).
- Provenance needs the repository to be public and `repository.url` in
  `packages/cli/package.json` to match it.

## Publishing `latest`

The **Release (latest)** workflow (`.github/workflows/release-latest.yml`) publishes one
stable version under the `latest` dist-tag, always with provenance. It runs only by hand,
only from `main`, and refuses to run while the repository is private. Inputs: `version`
(default `0.3.0`, must be a plain `x.y.z` that is not on npm yet) and `dry_run` (default
on: everything except the upload).

It lints, builds, type-checks, tests, smoke-tests the tarball, sets the version in
`packages/cli/package.json`, rebuilds with a clean stamp and publishes. Nothing is
committed from the workflow. Afterwards, by hand:

```sh
pnpm changeset version          # consumes the pending changesets, writes the changelog
# set packages/cli/package.json to the published version if changesets computed another
git commit -am "release: uptide x.y.z" && git tag vx.y.z && git push --follow-tags
```

Running this workflow is the owner's decision; no other workflow or script moves `latest`.

## Optional telemetry capture

Both release workflows embed `UPTIDE_TELEMETRY_BUILD_KEY` from the same-named GitHub
Actions repository secret and use `https://eu.i.posthog.com` as the build host.
Without the secret, published builds send no telemetry. Configure only a write-only
project capture key after enabling discard-client-IP and verifying automatic 90-day
deletion in the EU project. See [the telemetry deployment checklist](telemetry.md#release-configuration-maintainers).
Do not use a personal API key. This key is intentionally public in the CLI bundle;
it is supplied through the pipeline rather than committed to source.
