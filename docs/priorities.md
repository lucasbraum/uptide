# Priorities in `uptide list`

`uptide list` opens with PRIORITIES: what to upgrade first, why, and the command to start.
Every rule is deterministic, runs in the same pass as discovery and calls no LLM. The rules
live in one module, `packages/core/src/list/priorities.ts`, with a unit test per signal.

## Signals

Each outdated direct dependency gets these signals (JSON: `packages[].signals`).

| Signal | When | Source |
| --- | --- | --- |
| security | a known advisory covers the **installed** version | one POST to npm's `/-/npm/v1/security/advisories/bulk` for every public package; packages from a private registry or scope are never sent; off with `--no-advisories` or `"advisories": false` in `uptide.config.json` |
| deprecated | the registry marks the installed version deprecated | the abbreviated packument discovery already fetches |
| unsupported | a newer major exists and the installed major line's last release is 12 months old or more | the registry's `time` map, fetched only for packages with a newer major |
| drift | workspaces declare different majors of it (`5.x` and `7.x`): aligning them is a cheap consolidation win | lockfile versions |
| blocking | its installed peer range holds back another outdated package (`blocks react 19`) | installed manifests |
| behind | two or more majors behind (one is the normal state of an outdated package) | versions |
| effort | files to touch + call sites / 10, halved by a verified migration pack | the usage scan |

The advisory request and the publish dates each have a 5-second deadline and never retry. If
the advisory request fails, times out, is turned off or every package is private, the
PRIORITIES heading says “advisories not checked” with the reason, and the run goes on; nothing
is guessed.

## Runtime and dev

Each package is **runtime** when a workspace declares it in `dependencies` or
`optionalDependencies` (or it is the peer of a package that is), and it is not tooling; it is
**dev** when it is only in `devDependencies`, or is tooling (a test runner, a linter, a build
tool). JSON: `packages[].kind`.

A dev package's advisory drops one severity step, and at equal urgency the runtime package
comes first. So:

    runtime critical  >  runtime high  ≥  dev critical  >  runtime moderate  ≥  dev high  > …

A high advisory in a runtime dependency outranks a critical one in a dev-only test runner: both
rank 5.3, and runtime wins the tie. A dev critical still outranks a runtime moderate. The reason
of a dev row starts with `dev · `, for every signal: `dev · 2 advisories (1 critical), fixed in
1.2.6 (patch, same major)`.

## The smallest fix

For a security row, the fix is the lowest stable version above the installed one that none of
its advisories covers, and the reason says what moving there is:

- `fixed in 3.2.5 (patch, same major)` or `fixed in 4.18.0 (minor, same major)`;
- `needs 4.1.11 (major)` when every version of the installed major is affected;
- `no fixed version yet` when no published version is clean.

At equal urgency (and the same runtime/dev side), a same-major fix ranks above a major-only
one: it is the cheaper way out. The row's command checks that version, not the latest:
`uptide check moment --target moment@2.29.4`.

## Ranking

A package is ranked by its most urgent signal:

| Urgency | Signal | Reason, as printed |
| --- | --- | --- |
| 5 (+0.4 critical, +0.3 high, +0.2 moderate, +0.1 low; −0.1 for dev) | security | `2 advisories (1 high), fixed in 3.1.2 (patch, same major)` |
| 4 | deprecated | `deprecated: <registry message, truncated to 60 characters>` |
| 3 | unsupported | `4.x line unsupported since 2025-03, 37 files to touch` |
| 2.5 | drift | `version drift: 5.x and 7.x across 3 workspaces` |
| 2 | blocking | `blocks ai 7` |
| 1 | behind | `3 majors behind, 2 files to touch` |

PRIORITIES shows two tiers (JSON: `priorities[].tier`). **Urgent** is security and deprecated,
with a count and up to five rows (all with `--all`). **Worth planning** is everything else,
collapsed to its count until `--all`.

A package installed at several versions across workspaces is one row: its advisories are those
of any installed version, and its smallest fix is the first clean version above all of them.

The dev step is applied before ranking (a dev critical ranks 5.3). Among equal urgencies:
runtime before dev, then a same-major fix before a major-only one, then the cheaper upgrade
(lower effort).

## Groups

A group is one row, named after the group, with the command `uptide check --group <id>`. It is
ranked by its most urgent member (then the one furthest behind, then the cheapest), and costed
as the sum of its members' effort. Moving with, or holding back, another member of the same
group does not make the group urgent: upgrading the group together is what it already says.

## The cheap batch

When nothing is urgent, `list` says so and suggests one PR of minor and patch upgrades with no
urgent signal that touch at most 3 files each (possibly-unused packages excluded). A group
joins the batch only when all its members qualify. `Next` points to the top priority, or to the
cheap batch when nothing is urgent.

## Output

The terminal shows at most 5 rows (`--all` shows every one). The HTML report shows all of them
at the top with the same reasons, and its Priority tile filters the table to their packages.
JSON has `priorities`, `cheapBatch` and `advisories` (`checked` with the package count, or
`not checked` with the reason).
