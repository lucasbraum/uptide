---
"uptide": patch
---

stripe: a test fixture that was already cast straight to an SDK type (`{...} as
Stripe.Subscription`) and stops compiling after the bump is widened by rule to
`as unknown as`, and reported as "Test fixture casts widened"; a fixture with only the old
subscription period fields gains the item that carries them. Casts the agent adds are still
rejected. The `subscriptionPeriod` helper is placed by rule above the doc comment of the
function that needs it when no shared client module is in reach.

The Tests line adds workspaces up: "5 tests in 3 files passed".
