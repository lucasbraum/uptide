---
"uptide": minor
---

`check` reports one breaking finding when a member the target no longer sees was declared by
your own code in an augmentation: a custom matcher on the global `jest.Matchers` in a test
setup file, or an interface augmented in a `declare module "x"` block. The finding is anchored
at that declaration (the `declare global` block, or the augmented interface), where the one
edit is, and the call sites that fail (TS2339, TS2551) are listed under it as evidence, in the
terminal, the HTML report and the JSON report. Before, each call site was a breaking finding
of its own next to the declaration. The README's line budget no longer counts the generated
"Verified packs" table, which grows one row per pack.
