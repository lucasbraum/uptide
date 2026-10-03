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

Run the CLI you just built against any repository:

```sh
node packages/cli/dist/index.js check --cwd /path/to/repo
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
  `--no-llm` turns that off. No telemetry, no account, no server.
- Nothing is pushed or published without an explicit flag from the user.

## Pull requests

- One change per pull request, with tests. A bug fix starts with a test that fails.
- Small files and pure functions; comments say why, not what.
- Ask in an issue before adding a dependency.
- Keep the README honest: if behavior changes, the README changes in the same pull request
  (`packages/cli/src/readme.test.ts` checks its flags and examples against the CLI).
- Add a changeset for anything a user would notice: `pnpm changeset`.
- `pnpm lint && pnpm typecheck && pnpm test` pass before you ask for review.
- Commit messages follow `type(scope): what changed`, as in `git log`.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](SECURITY.md), not public issues.
