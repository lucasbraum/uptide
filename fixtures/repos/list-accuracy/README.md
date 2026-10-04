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

Re-run: `pnpm --filter @uptide/core exec vitest run src/list/accuracy.test.ts src/list/registry.test.ts`.

## Public registry runs

Measured on 2026-10-04, Node 22, with the packaged CLI (`list --all --json --ci --cwd <checkout>`),
no dependency installation and the repositories' committed Yarn lockfiles. Times include the
local syntax scan; npm metadata was fetched live without an Uptide registry cache.

| Public checkout | Declared dependencies | Outdated | Unknown latest | Network failures | Discovery time |
| --- | --- | --- | --- | --- | --- |
| webpack `62f7a27c7e09b91ecf43bcaf1730288b33cbd77f`, before this fix | 121 | 5 | not exposed | 63 timeouts | 4.497 s |
| Same webpack checkout, after | 121 | 14 | 0 | 0 | 5.456 s |
| webpack v5.50.0 (`400a0f94ab45ca20b10f219c8311e87d3d3f108c`), after | 93 | 73 (47 major / 20 minor / 6 patch) | 0 | 0 | 2.482 s |

Both after-runs still exit 2 for one separate, pre-existing metadata limitation: npm alias
`prettier-2` on current webpack, and the GitHub shorthand `tooling: webpack/tooling#v1.19.0`
on v5.50.0. These are not network timeouts. The current checkout's reported 14 upgrades
include the alias row, whose target is not reliable until alias resolution is supported.
Neither alias nor GitHub shorthand resolution is changed by this timeout fix.
