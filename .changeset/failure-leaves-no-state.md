---
"uptide": patch
---

A package whose analysis fails no longer changes the results of the packages checked after it
in the same run. A failure inside TypeScript's printer (a stack overflow, as `@types/node`
20 → 22 caused before #31) left its partial output in the shared printer, and the next
package's signatures silently began with it. Printing now recovers from a failed print, and
after any package fails, `check` discards the shared TypeScript state (printer, the
repository's program and checker, cached surfaces) before the next one.
