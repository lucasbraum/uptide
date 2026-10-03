# 0001: ts-morph over the raw TypeScript compiler API

Status: accepted (2026-09-27)

## Context

The adapter walks exported declarations, their members, JSDoc tags and heritage clauses
across thousands of files (stripe ships 160 declaration files merged through 139
`declare module 'stripe'` blocks). The raw compiler API exposes all of this, but through
`ts.Node` unions, manual `forEachChild` traversal and symbol-flag arithmetic that every
walker function would have to repeat.

## Decision

Use ts-morph for navigation (`getExportedDeclarations`, typed member getters, JSDoc
access, `getSymbolAtLocation`) and drop to the compiler API only where ts-morph is lossy
or where printing is involved: the merged-symbol walk of namespaces and ambient modules
(`getExportsOfModule` on the checker), the printer with `removeComments`, and the
transformer that sorts unions and simplifies `import("./x").T`.

## Consequences

- Walker code reads as "for each property, for each overload group", not as node-kind
  switches. `walk.ts` is about 500 lines for the whole surface.
- ts-morph's convenience views are pre-merge in two places we hit: `getExportedDeclarations`
  flattens `export =` targets and drops cross-file ambient module blocks. Both are worked
  around explicitly and documented in `architecture.md`.
- ts-morph vendors its own TypeScript. Our workspace pins TypeScript 5.9 for our own
  type-checking; the adapter's parsing version is whatever ts-morph bundles, and
  `SURFACE_SCHEMA_VERSION` guards cached surfaces across upgrades.
