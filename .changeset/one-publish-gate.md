---
"uptide": patch
---

`fix --pr` and `pr-body` share one gate: a failed verification or a run from an Uptide
checkout with uncommitted changes is never published, and the CLI says why. Tests are
detected the same way everywhere (workspace script, the vitest or jest config covering the
workspace scoped to related tests, root script) and the report says what ran. A PR body
only contains what its own run found, and a stripe body says when no API change affects
the code.

`fix` formats the files it edited, and only those, with the repository's formatter, and runs
the repository's lint on them; a new lint failure fails verification. `uptide verify`
verifies a migration branch again where it stands, adding commits and never rewriting
history. A failing test outside the affected files is rerun once. The zod pack finds what
depends on zod 3's default error messages and fixes the test that fails on them; the stripe
pack makes tests follow the pinned API version.
