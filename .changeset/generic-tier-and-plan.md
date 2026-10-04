---
"uptide": minor
---

Generic mode and support tiers.

`uptide check` with no `--only` now analyzes every direct dependency that is behind, ranked
by likely impact, within `--max-time` (default 60 s), and lists what it did not reach.
Every dependency has a tier: `verified` (a migration pack) or `generic` (no pack: a finding
is breaking only when the compiler or the runtime probe confirms it; the rest is in
`--details`). One dependency failing no longer empties the report.

`uptide fix --only <any dependency>` migrates a generic dependency with the agent under the
same verification and publish gate, with `--max-cost` (default $1) and a pull request note
that no pack covers the package. Without `ANTHROPIC_API_KEY` it says what it cannot do and
changes nothing.

`uptide plan` prints the order to upgrade in: target versions, peer-range constraints
between packages and an effort estimate from the findings; also as JSON and HTML.
