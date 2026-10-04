---
"@uptide/core": patch
"uptide": patch
---

Honor npm INI parsing and registry/auth configuration precedence for dependency discovery,
with host/path-scoped credentials kept out of output and persistent caches. Fetch abbreviated
metadata with 16 concurrent requests, 10-second per-attempt timeouts and one retry on timeout/5xx.
Stop calling a host only after 401/403/405. Keep unresolved packages counted as unknown,
group repeated diagnostics by host/reason, and retain one incomplete HTML row per package.

Recognize package.json tooling fields, installed bins, AngularJS/gulp/Karma and hook configs,
stylesheet imports and HTML node_modules assets before flagging possibly unused dependencies.
Keep that section collapsed with cautious wording and per-package reasons. Number HTML
sections sequentially according to the sections present.

Classify non-registry declarations and aliases as intentional skips, with collapsed terminal/HTML
reasons and no error exit. Resolve npm registry aliases by their real package names, preserve
local import usage, and read the correct pnpm/Yarn alias versions from lockfiles.

Recognize tool rc files, hook/task commands, generic package configuration fields, Karma
short names and auto-loaded plugins, colliding bins and required direct dependencies.
Show the actual shared failure reason in discovery summaries. Add opt-in list --verbose
phase timings and file counts, and preserve pnpm default/named catalog discovery.

Preserve independently used group members' classifications and reasons. Read legacy lint-staged
linters maps alongside flat configs, keeping ignore globs separate from commands. Prune vendored,
generated and Git-ignored sources, prefilter with text/lexical gates before full parsing,
and distribute large syntax batches across CPU workers. Report per-reason skip counts in verbose
output while retaining complete group membership in JSON and check commands.

Keep tool-specific ignores out of source discovery: formatting/linting scopes do not imply
unused code. Warn in the summary, HTML, JSON and verbose output when Git rules exclude more
than half of candidate application sources, naming the responsible patterns. Count Git-ignored
sources from filenames only; retain usage under blanket prettier/eslint/lint-staged ignores.
