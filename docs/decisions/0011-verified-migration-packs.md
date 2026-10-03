# Dependency-specific packs and verified assisted edits

Status: accepted, 2026-10-01.

We freeze general analysis and use zod/Stripe to validate complete migrations. Packs
own version knowledge and narrow transforms; the runner owns check, installation,
verification, commits and PR publication. Transformations are restricted to reported
sites. A generic text replacement is insufficient for message evaluation order, aliases,
comments or Stripe API dates.

A clean repository and a new branch make each change reviewable. Eval uses separate git
worktrees. Installation disables lifecycle scripts. Mechanical changes are verified with
the target installed; assisted patches are accepted one at a time only when the targeted
diagnostic disappears and no new diagnostics appear. Existing errors are multiset-
subtracted. Tests have a timeout, and missing scripts are reported rather than fabricated.
A failed verification never publishes a PR.

The user explicitly opted into Anthropic-assisted fixing in this milestone. With an API
key, only the relevant finding, guide, function/declaration and error are submitted.
Without a key, assisted work stays manual. This supersedes the earlier no-LLM constraint
for `fix` only. Costs are estimates from token usage; no live agent evaluation can be
claimed when a key is absent. API shape and pricing references:
https://platform.claude.com/docs/en/api/http/messages and
https://platform.claude.com/docs/en/models/sonnet-4-6/overview.

Stripe server API changes are never mechanical, even if a literal edit makes TypeScript
pass. The changelog snapshot is generated during pack maintenance, not runtime. The
review report carries every intervening stable-release entry plus dashboard/webhook
and cross-service checks. Compilation checks SDK types; it does not simulate Stripe.
