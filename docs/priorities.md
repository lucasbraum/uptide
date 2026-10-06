# Priorities in `uptide list`

`uptide list` opens with PRIORITIES: what to upgrade first, why, and the command to start.
Every rule is deterministic, runs in the same pass as discovery and calls no LLM. The rules
live in one module, `packages/core/src/list/priorities.ts`, with a unit test per signal.

## Signals

Each outdated direct dependency gets these signals (JSON: `packages[].signals`).

| Signal | When | Source |
| --- | --- | --- |
| security | a known advisory covers the **installed** version | one POST to npm's `/-/npm/v1/security/advisories/bulk` for every public package; packages from a private registry or scope are never sent |
| deprecated | the registry marks the installed version deprecated | the abbreviated packument discovery already fetches |
| unsupported | a newer major exists and the installed major line's last release is 12 months old or more | the registry's `time` map, fetched only for packages with a newer major |
| blocking | its installed peer range holds back another outdated package (`blocks react 19`) | installed manifests |
| behind | two or more majors behind (one is the normal state of an outdated package) | versions |
| effort | files to touch + call sites / 10, halved by a verified migration pack | the usage scan |

The advisory request and the publish dates each have a 5-second deadline and never retry. If
the advisory request fails, times out or every package is private, the PRIORITIES heading says
“advisories not checked” and the run goes on; nothing is guessed.

## Ranking

A package is ranked by its most urgent signal:

| Urgency | Signal | Reason, as printed |
| --- | --- | --- |
| 5 (+0.4 critical, +0.3 high, +0.2 moderate, +0.1 low) | security | `2 advisories (1 high), fixed in 3.1.2` |
| 4 | deprecated | `deprecated: <registry message, truncated to 60 characters>` |
| 3 | unsupported | `4.x line unsupported since 2025-03, 37 files to touch` |
| 2 | blocking | `blocks ai 7` |
| 1 | behind | `3 majors behind, 2 files to touch` |

Among equal urgencies, the cheaper upgrade (lower effort) comes first. “Fixed in” is the lowest
stable version above the installed one that none of its advisories covers.

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
