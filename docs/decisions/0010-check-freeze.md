# Freeze generic check; deliver zod and stripe migrations

Status: accepted, 2026-10-01. Generic analysis is frozen after Part A.

`check` covers TypeScript/JavaScript imports and statically bound require calls,
workspace importers/catalogs, source resolution of workspace dependencies, API diffs,
baseline-subtracted compiler diagnostics and runtime export/load probes. npm ranges
use node-semver. Runtime notes show used keys; unused removals are counted once.
Native/lifecycle-dependent probes remain unverified, with one package-level warning.
Runtime surfaces persist by package, version and Node major with a schema marker;
transient dependency failures are retried rather than preserved indefinitely.

Known limits: dynamic loading/reflection, package subpaths not probed at runtime,
native packages, behavioural changes beyond export shapes, and Node minor differences
within the cache's major-version key. A successful probe is not a runtime behaviour test.
Signal C's Node permission model and socket preload are defensive restrictions, not
an OS-level isolation boundary against hostile packages. `check` never modifies repo
files or runs installation scripts. Future work is limited to the zod/stripe packs and
their fix/verification flow, not new general-purpose analysis.

Ground truth from a private pnpm workspace on zod 3 and stripe 22 (not part of this
repository): zod/api 4 errors, zod/shared 21 errors, stripe/api 1 error. The preceding
verified check matched all 26 locations; API-change attribution was 4/4, 18/21, and 1/1
respectively. Cause anchors are not errors. These are ground-truth numbers from one
repository, not a universal precision claim. The public ground truth in this repository is
`fixtures/truth/storefront.json`.

Part A rerun on a second private repository, an API service (2026-10-01): 140 dependencies
considered, 32 analyzed;
4 breaking, 2 deprecated, 17 unverified, 58 unaffected, 58 not imported.
Express 4.21.2 → 5.2.1: 32 analyzed sites, zero actionable findings; the three
previously unverified sites now compile/load and are informational. First run
182.485s, warm 111.346s. These timings remain a known limit, not a new optimization
project. Offline suite at freeze: core 321 passed / 12 network-gated skipped; CLI 18 passed.
