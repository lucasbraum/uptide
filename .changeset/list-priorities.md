---
"uptide": minor
---

`uptide list` opens with PRIORITIES: up to five rows, most urgent first, each with a one-line
reason and the command to run. Signals are known advisories for the installed version (one
request to npm's bulk advisory endpoint, public packages only; “advisories not checked” on
failure), a deprecated installed version, a major line with no release in a year, a peer range
holding another upgrade back and two or more majors behind; cheaper upgrades come first among
equals. When nothing is urgent, it suggests the cheap batch. `Next` points to the top priority.
Rules and weights: docs/priorities.md. No LLM calls.

Groups: a scope is one family (`@radix-ui/*`) whatever versions its members are at, and
packages group across scopes when a peer range of one's latest version needs the other or both
pin the same exact dependency version (`ai + @ai-sdk/*`). Each group says why.

The HTML report's tiles (Outdated, Major, Minor, Patch, Groups, Tooling, Priority, Verified,
Possibly unused) filter the table, with the filter in the URL hash; each tile's count is the
number of rows it shows. A Priorities block opens the report.
