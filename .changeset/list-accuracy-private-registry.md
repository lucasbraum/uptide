---
"@uptide/core": patch
"uptide": patch
---

Honor npm INI parsing and registry/auth configuration precedence for dependency discovery,
with host/path-scoped credentials kept out of output and persistent caches. Bound list's
network work to 800 ms without retries and deduplicate incomplete packages in terminal and HTML.

Recognize package.json tooling fields, installed bins, AngularJS/gulp/Karma and hook configs,
stylesheet imports and HTML node_modules assets before flagging possibly unused dependencies.
Keep that section collapsed with cautious wording and per-package reasons. Number HTML
sections sequentially according to the sections present.
