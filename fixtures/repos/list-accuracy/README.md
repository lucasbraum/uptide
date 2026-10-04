# List accuracy fixtures

Invented packages and minimal configuration snippets only. No application code or real credentials.
`installed-bins/installed.json` is materialized as installed package manifests in a temporary directory by tests.
Registry requests are mocked; `.npmrc` values reference synthetic environment variables.

## Before / after

Measured against PR #8 (merge `21fad7a`) and this change, with every declared package resolving
from 1.0.0 to 2.0.0. Registry responses are synthetic and no application code is executed.

| Fixture | Tooling before → after | Possibly unused before → after |
| --- | --- | --- |
| package-fields | 8 → 10 | 3 → 1 |
| installed-bins | 5 → 5 | 1 → 1 |
| legacy-configs | 4 → 11 | 7 → 1 |
| web-assets | 0 → 8 | 9 → 1 |
| Total | 17 → 34 | 20 → 4 |

The legacy fixture's gulp import also moves from source usage to Tooling. Each fixture
intentionally contains one `orphan` dependency with no usage. Bin mapping already worked
in #8; its fixture protects that behavior.

With two private packages returning 401, failed registry requests fall from 4 to 2 and
failure rows from 4 to 2. With valid fixture credentials, both packages resolve and no
failure remains. The scoped registry + `${ENV}` token fixture also runs through the packaged CLI.

`large-registry` declares 80 invented packages. A local HTTP server delays every abbreviated
metadata response by 220 ms: all 80 resolve, with exactly 80 requests and at most 16 in flight.
This intentionally exceeds the former shared 800 ms deadline. Deterministic tests give each
attempt 10 seconds including stalled bodies, retry timeout/5xx once, keep failures as unknown,
and stop further requests to a host only after 401/403/405. A current/target metadata failure
also cannot hide an already-known outdated package.

`dependency-sources` covers 22 intentional skips: GitHub protocol/shorthand, Git HTTPS/SSH,
Git protocol/SCP, file/link/workspace, HTTP(S) tarballs, and npm aliases pointing to each source.
It also checks three registry aliases (including scoped auth and tooling) plus a normal registry
dependency whose lockfile contains a tarball URL. Non-registry specs never reach the registry;
registry tarball URLs in lockfiles do not cause false skips. Additional tests cover pnpm/Yarn
alias locks, different alias targets in workspaces, malformed declarations, exit codes, and
collapsed terminal/HTML output without source URLs or local paths.

Re-run: `pnpm --filter @uptide/core exec vitest run src/list/accuracy.test.ts src/list/registry.test.ts src/list/spec.test.ts`.

## Public registry runs

Measured on 2026-10-04, Node 22, with the packaged CLI (`list --all --json --ci --cwd <checkout>`),
no dependency installation and the repositories' committed Yarn lockfiles. Times include the
local syntax scan; npm metadata was fetched live without an Uptide registry cache.

| Public checkout | Declared dependencies | Outdated | Unknown latest | Network failures | Discovery time |
| --- | --- | --- | --- | --- | --- |
| webpack `62f7a27c7e09b91ecf43bcaf1730288b33cbd77f`, before this fix | 121 | 5 | not exposed | 63 timeouts | 4.497 s |
| Same webpack checkout, after | 121 | 14 | 0 | 0 | 5.456 s |
| webpack v5.50.0 (`400a0f94ab45ca20b10f219c8311e87d3d3f108c`), after | 93 | 73 (47 major / 20 minor / 6 patch) | 0 | 0 | 2.482 s |

At that stage, both after-runs exited 2 for one metadata limitation: npm alias
`prettier-2` on current webpack, and the GitHub shorthand `tooling: webpack/tooling#v1.19.0`
on v5.50.0. These are not network timeouts. The current checkout's reported 14 upgrades
include the alias row, whose target was unreliable before alias resolution.
The follow-up source classification/alias fix resolves both issues. Re-running the same
checkouts produces:

| Public checkout | Outdated | Intentional skips | Unknown / failures | Time | Exit |
| --- | --- | --- | --- | --- | --- |
| webpack `62f7a27` | 14 | 0 | 0 / 0 | 5.028 s | 0 |
| webpack v5.50.0 | 73 | 1 GitHub source | 0 / 0 | 2.422 s | 0 |

`prettier-2` now resolves `prettier`, comparing 2.8.8 → 3.9.9. The GitHub `tooling`
dependency is reported as “not checked: non-registry source (github)”.
