# 0006: Two signals for usage analysis, and the compiler as arbiter

Status: accepted (2026-09-28)

## Context

"Which of my lines does this upgrade affect" has two obvious answers, each wrong alone.
Symbol resolution (follow every import to every reference, map it to the canonical path
of milestone 1) explains *why* a line is affected, but it trusts the diff engine's verdict
on whether a change breaks, and that verdict is sometimes a text comparison. Compiling
the repository against the target version is the ground truth for *whether it compiles*,
but it says "error here", not "because `items[].quantity` was removed", and it cannot see
a runtime change that keeps compiling.

## Decision

Run both and join them. Signal A resolves references with the type checker and yields a
`Usage` per reference with its access kind. Signal B type-checks the repository twice, as
it is and with the analyzed package redirected to the target tarball through a temporary
`node_modules` overlay, and keeps only the diagnostics that are new. The merge attaches a
diagnostic to the usage it overlaps, or to the usages on the same line that a change
explains, or turns it into an `inferred` usage when its message names a package symbol;
what remains is reported as unattributed rather than dropped.

The compiler decides, the diff explains. A diagnostic on a usage makes its finding
breaking whatever the direction table said. Conversely, when Signal B ran and raised no
new diagnostic on a usage, a breaking verdict of any compile-time kind (removed, moved,
renamed, signature, required, type, narrowed) is `info` at confidence 0.3: never listed,
never counted, only mentioned in the hidden-findings line. The first version of this rule
exempted removals and checker-backed verdicts; the first real monorepo showed the
extraction, not the compiler, is what errs in those cases (members declared on mixins, an
`export =` turned `export default`), and 600 "breaking" findings on lines that compiled.
When the symbol's declaration file has unresolved imports in the target, the silence is
inconclusive and the finding is `unverified`: shown, not counted as breaking.
Deprecations are never downgraded.

## Consequences

- A repository with pre-existing type errors still gets checked: baseline errors are
  subtracted, not a reason to skip. Only a structurally broken baseline skips the overlay.
- Signal B runs only for packages Signal A found usages of, and `--no-compile` turns it
  off; Signal A alone still produces a complete, if less certain, report.
- The target's own dependencies resolve at the versions it declares (ADR 0009); what is
  still missing is counted and shown as a warning, never as a finding.
