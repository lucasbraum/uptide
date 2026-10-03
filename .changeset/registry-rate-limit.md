---
"uptide": patch
---

A registry that rate limits (HTTP 429) or is briefly down is retried with backoff, and a
dist-tag it answered before is taken from the local cache when it cannot answer now. When
it still fails, `check` exits 2 and says so, instead of "not analyzed" with exit 0.

Under `Node16`/`NodeNext` module resolution, `check` now finds usages of packages that ship
separate declarations for `import` and `require` (stripe 22 and newer); they were reported
as not imported.
