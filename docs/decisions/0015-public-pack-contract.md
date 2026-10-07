# Packs are a public contract, verified against public repositories

Status: accepted, 2026-10-07. Builds on 0011 (verified packs) and 0012 (generic tier).

Two packs were written by the people who wrote the runner, and their claims rested on one
synthetic fixture. More packs need a contract someone else can meet and a test someone else
can run, and the `verified` label has to mean the same thing for every pack.

- The contract is code (`packages/core/src/packs/contract.ts`): metadata with sources, rules
  that claim `check`'s findings and rewrite one reported site, behavior notes for what the
  compiler cannot see with how each is reported, agent instructions, fixtures, ground truth.
  `definePack` derives the runner's hooks from that alone; zod and stripe implement the same
  interface by hand and keep their outputs.
- Ground truth is public repositories at the commit before their upgrade, with expected
  findings read from their own upgrade and the compiler. Scoring runs `check` with the pack,
  the same code path users get, and compares the plan's sites per rule.
- `verified` needs two public repositories and no false positive among breaking findings.
  Recall is reported, not gated: a pack that finds less is still safe to run, a pack that
  claims something false is not. Below the bar a pack ships as a candidate and the CLI treats
  the dependency as generic.
- The CLI reads the status from a committed record (`verification.json`) tied to the digest
  of the ground truth; CI runs `pack test` and fails when the record no longer matches. The
  CLI never fetches ground truth at runtime.

Consequences accepted: scoring needs the ground-truth repositories installed (with scripts
off), which costs network and disk once and is cached; a pack's rule ids for sites it does
not own are `generic`; a change to the engine can change a pack's score, which is why the
Packs workflow also runs when `check` changes.
