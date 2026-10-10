---
"uptide": minor
---

A verified migration pack for Vitest 4 → 5, scored against votingworks/vxsuite and
vitorvasc/opentelemetry-ecosystem-explorer at the commit before their own upgrade. It is verified
with two public repositories and no false positive among breaking findings (recall 50%). Sites it finds: custom matchers declared on the global
`jest.Matchers` or on a one-parameter `Assertion<T>`, `import '@testing-library/jest-dom/vitest'`
registrations whose types stop reaching `expect`, the removed `bench` export, bare-directory
`coverage.include` and `coverage.exclude` entries, and the removed `vitest/*` entry points
(`vitest/coverage`, `vitest/reporters`, `vitest/environments` and `vitest/snapshot` are
rewritten). What the compiler cannot see (mock history cleared by default, `testNamePattern`
joined with " > ", hoisted `vi.mock` calls, un-awaited assertions, timers, report locations,
browser mode) is listed for review.
