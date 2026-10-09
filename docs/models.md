---
title: Models
description: Which LLM provider and model assisted fixes use, how to choose one, what the budget flag reserves, and custom OpenAI-compatible endpoints.
---

# Models

For someone running `uptide fix` with an API key who wants to choose the provider, the
model and the budget, or point at their own endpoint. Measured results per provider are in
the [provider evaluation](provider-evaluation.md); rates in [model pricing](model-pricing.md).

## Choosing a provider and model

Assisted fixes support Anthropic, OpenAI and Gemini (experimental), with the same prompts,
tool, verification and publish gate. Set the chosen provider's key in your environment:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`. Never put keys in repository
config or command arguments.

```sh
npx uptide fix zod --provider openai --model gpt-6.1-sol
UPTIDE_PROVIDER=gemini UPTIDE_MODEL=gemini-3.8-flash uptide fix stripe
npx uptide fix zod --max-cost 1
npx uptide fix zod --no-llm
```

For each setting, precedence is flag → `UPTIDE_PROVIDER` / `UPTIDE_MODEL` → nearest
`uptide.config.json` up to the Git root. Without a provider setting, detection checks
`ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`, then `GEMINI_API_KEY`; Anthropic remains the
overall default. An explicitly selected provider never falls back to another provider. The
selected provider/model prints before the fix starts, and spend prints at the end.

The optional config accepts **only** `provider` and `model` strings:

```json
{ "provider": "openai", "model": "gpt-6.1-sol" }
```

Unknown fields, nested settings and key-like values are rejected, including when flags would
override them. Keys are read only from the environment. No key: a generic fix exits before
cloning, installing or creating a branch; migration packs still apply rule-based fixes and
leave assisted sites manual. `--no-llm` disables all model calls.

## Defaults

Checked against official documentation on 2026-10-04:

| Provider | Default | Reference |
| --- | --- | --- |
| Anthropic | `claude-sonnet-5-5` (`medium` effort) | [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview); selected after the storefront comparison |
| OpenAI | `gpt-6.1-sol` | [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), through the Responses API |
| Gemini | `gemini-3.8-flash` | [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |

Measured on the public storefront fixture (2026-10-04; USD from returned usage). Each cell
lists **zod / Stripe**; every run has a $1 ceiling:

| Provider | Model | Verified | Agent sites | Attempts | Cost USD |
| --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-sonnet-5-5 (medium)` | pass / pass | 4 / 3 | 2 / 2 | $0.013244 / $0.021592 |
| OpenAI | `gpt-6.1-sol` | pass / pass | 4 / 3 | 2 / 3 | $0.006806 / $0.018677 |
| Gemini | `gemini-3.8-flash` | fail / fail | 0 / 0 | 12 / 9 | $0.000000 / $0.000000 |

Gemini's serial reruns failed after HTTP 503/429 and transport errors, despite a successful
protocol smoke. Its zero confirmed cost excludes $0.473901 / $0.368667 retained for
unreported usage; it is not a claim of zero possible billing. Full trials, reservations,
times, exact echoed IDs and the Sonnet 4.6/high/medium comparison are in the
[provider evaluation](provider-evaluation.md). These single fixture trials are not a general
model ranking.

Tool choice follows each model's capabilities. Sonnet 5.5 uses `auto` with a strict
`submit_patch` schema and a tool-only system instruction; Sonnet 4.6, OpenAI and Gemini use
forced tool calls. Missing or invalid calls consume an attempt and their reported cost, then
receive the feedback "respond only by calling submit_patch". HTTP 429 is reported as rate
limiting, waits for `Retry-After` (60 seconds when absent), and retries only when another
reservation fits the budget.

## `--max-cost`

`--max-cost` defaults to **$1 per package**, including zod and stripe. Before every call and
retry, Uptide reserves its worst-case input and maximum output cost. A call that would exceed
the remaining budget is never sent. Actual returned usage replaces the reservation; failures
without valid usage keep the full reservation, shown separately as unknown spend. Rejected
patches still consume budget. Unfinished sites remain manual and cannot pass the publish
gate. Unknown models use the provider's highest listed rates with a warning. See
[model pricing](model-pricing.md) for rates, token estimation and the scope of accounting.

## `OPENAI_BASE_URL`

`OPENAI_BASE_URL` selects an OpenAI **Chat Completions-compatible, not verified** endpoint.
Uptide appends `/chat/completions` to the supplied API base URL and uses Bearer
authentication, strict functions and forced `submit_patch`. The official OpenAI endpoint uses
Responses when this override is absent. HTTPS is required, except HTTP localhost for local
servers. Custom deployments must support this protocol and the supplied model ID;
Azure-specific authentication and routing are not inferred. Custom endpoint prices may
differ from the built-in OpenAI table.

## Privacy

Assisted fixes send the finding, enclosing code snippet and compiler error to the provider
you chose (or your `OPENAI_BASE_URL`). Your provider's data policy applies. `--no-llm` keeps
assisted fixes off. Anonymous telemetry, when enabled, adds only the provider and a public
model ID; private/custom model IDs become `custom`. The full model: [privacy](privacy.md).
