# Development

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and the rules; this page lists the
evaluation and release tooling.

```sh
pnpm test                       # offline regressions
UPTIDE_NETWORK=1 pnpm test      # real package digests and Stripe tsc fixture
pnpm eval:fix /path/to/repo --without-key
pnpm eval:fix /path/to/repo --with-key
pnpm eval:fix /path/to/repo --only=stripe --target=stripe@22.6.2 --without-key
pnpm eval:check fixtures/repos/storefront --truth=fixtures/truth/storefront.json
```

`eval:check --truth` scores a check against the new `tsc` errors a real upgrade produced
(`fixtures/truth/storefront.json`: the synthetic storefront workspace on zod 4 and stripe 23,
after `pnpm install --ignore-scripts` in the fixture);
a case's `runtime` sites are what no compiler shows, such as a Stripe client created
without `apiVersion`, scored apart.

`eval:fix` creates a temporary git worktree, copies installed dependencies (not symlinks
to the source repo), and retains the result for review. Artifacts go in `eval-out/`.
`--with-key` fails explicitly when no key is configured. `pnpm eval:stripe-fixture`
measures the checked-in Stripe consumer with real `tsc`; `pnpm build:stripe-changelog`
refreshes the versioned public changelog JSON. Migration execution never fetches it.

`uptide diff <pkg> <from> <to> [--json]` compares the full public surface of two
versions. Tarballs, surfaces and runtime probes are cached in `~/.cache/uptide/`.
Releasing is described in [docs/releasing.md](releasing.md); `pnpm smoke` runs the
packed CLI against npm v3, npm workspaces v2, pnpm catalogs, Yarn classic and Yarn Berry fixtures in clean Node 20/22 containers. Run `pnpm smoke 20` and `pnpm smoke 22`. Each case verifies zod migration and a compatible Stripe SDK upgrade without an LLM; lifecycle-script traps must remain untouched. Lockfile diffs and JSON results are saved beside the temporary CLI tarball.

Yarn PnP remains unsupported. Missing package-manager binaries or mismatched pinned versions fail with an exact Corepack recovery command. Unsupported range/lockfile syntax fails explicitly rather than silently broadening the upgrade.
