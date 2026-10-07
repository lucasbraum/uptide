---
"uptide": minor
---

Migration packs are a public, testable contract (docs/packs.md). `uptide pack new` scaffolds
a pack (an example rule, a fixture pair, a test, empty ground truth) and registers it;
`uptide pack test` scores packs against their fixtures and against public repositories at the
commit before their upgrade, with precision and recall per rule, every false positive and
false negative, and `--json` for CI. A pack is labeled verified only with ground truth from at
least two public repositories and no false positive among its breaking findings; otherwise it
ships as a candidate and `check`, `list` and `fix` treat the dependency as generic.
