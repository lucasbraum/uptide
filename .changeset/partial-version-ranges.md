---
"uptide": patch
---

Preserve partial version ranges such as `^18`, `~18.2`, and `18.x` when fixing packages and their companions, including workspace manifests and pnpm catalogs. Reject unsupported complex ranges before cloning or spending on assisted fixes, with the declaration location and an installed-version replacement suggestion.
