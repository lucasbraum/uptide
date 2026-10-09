---
"uptide": minor
---

**One finding for one edit, across workspaces.** When call sites in different workspaces of a
repository fail because of the same local declaration (a hook's parameter typed
`RefObject<HTMLElement>` that `useRef` no longer satisfies), `check` now reports one breaking
finding at that declaration and lists the call sites under it as evidence, as it already did
when two sites in one workspace tripped it. The JSON report adds `callSites` to such an anchor
(how many call sites trip it, every workspace counted; `downstream` lists them) and `sharedCause`
to a lone site's finding before it is joined; nothing is renamed or removed. `check --details`
and the HTML report print `N call sites` under the anchor. `uptide pack test` scores the anchor
at the declaration; the call sites under it are neither true nor false positives.
