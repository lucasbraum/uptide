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
failure remains. A deterministic clock test stalls both private responses and verifies
that discovery stops at the shared 800 ms deadline while retaining a fast public package.

Re-run: `pnpm --filter @uptide/core exec vitest run src/list/accuracy.test.ts`.
