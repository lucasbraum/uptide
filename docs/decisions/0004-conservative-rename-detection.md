# 0004: Rename hints, never a `renamed` kind

Status: accepted (2026-09-27)

## Context

When a symbol disappears and a similar one appears, a code modifier would love to know
they are the same thing. But the evidence is weak: stripe has hundreds of interfaces with
the identical header `interface extends EventBase`, and a first version of the matcher
confidently paired `InvoiceitemUpdatedEvent` with `InvoiceOverdueEvent`. A wrong rename
sends the future code modifier down the wrong path; a missed one costs a reviewer a
glance.

## Decision

Emit `removed` plus `added`, and put the guess on the `removed` change as `replacement`
with `confidence < 1`. The `ChangeKind` `renamed` exists in the type but is never
produced. Evidence rules:

- Leaves match on signature (identical: 0.8; similar text: 0.6), and a trivial signature
  such as `string` also needs name similarity.
- Containers match on name similarity plus overlap of their members' names and
  signatures, never on the header alone.
- A hinted container passes the hint to members whose counterpart exists under the new
  name. Ties produce no hint.

## Consequences

- Stripe's `InvoiceitemCreatedEvent` still maps to `InvoiceItemCreatedEvent`; the false
  pairs are gone.
- Consumers of `Change[]` must treat `replacement` as a suggestion. Milestone 2's usage
  finder can confirm a rename by looking at how the old and new names are used.
