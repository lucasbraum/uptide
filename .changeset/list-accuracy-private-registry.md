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
