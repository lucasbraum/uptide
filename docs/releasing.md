# Releasing

One package is published: `uptide` (`packages/cli`), with the engine bundled in.
`@uptide/core` is never published; changesets ignores it.

## Day to day

Add a changeset with every user-visible change to the CLI:

```sh
pnpm changeset        # pick `uptide`, patch/minor/major, one-line summary
```

## Publishing

1. Open a version PR running `pnpm changeset version` to update package versions and the changelog. For `next`, prepare the prerelease version in this PR (for example, `pnpm changeset version --snapshot next`).
2. Merge the version PR.
3. Run **Release (latest)** or **Release (next)** at that merged ref with the same `version` as `packages/cli/package.json`. Use `dry_run` to validate without publishing.
4. Tag the released commit `vX.Y.Z` (use the full prerelease version for `next`) and push the tag.

Both workflows reject a version mismatch before installing dependencies and never
rewrite versions. `latest` requires the public repository's `main` branch and a stable,
unpublished version; `next` only moves the `next` dist-tag. Configure the `NPM_TOKEN`
repository secret for publishing. npm provenance is required for `latest` and enabled
for `next` when the repository is public; the CLI's `repository.url` must match the
publishing repository.

## Optional telemetry capture

Both release workflows embed `UPTIDE_TELEMETRY_BUILD_KEY` from the same-named GitHub
Actions repository secret and use `https://eu.i.posthog.com` as the build host.
Without the secret, published builds send no telemetry. Configure only a write-only
project capture key after enabling discard-client-IP and verifying automatic 90-day
deletion in the EU project. See [the telemetry deployment checklist](telemetry.md#release-configuration-maintainers).
Do not use a personal API key. This key is intentionally public in the CLI bundle;
it is supplied through the pipeline rather than committed to source.
