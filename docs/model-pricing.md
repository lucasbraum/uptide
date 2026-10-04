# Model pricing and budget accounting

Reviewed **2026-10-04**. USD per million tokens, standard text inference. Source of
truth in code: `packages/core/src/llm/pricing.ts`. No paid built-in tools, batch,
priority processing, explicit prompt caching or service-tier upgrades are requested.

| Provider/model | Input | Output | Cached input | Cache write (5m / 1h where applicable) |
| --- | ---: | ---: | ---: | ---: |
| Anthropic Sonnet 4.6 | 3 | 15 | 0.30 | 3.75 / 6 |
| Anthropic Sonnet 5.5 | 2 | 10 | 0.20 | 2.50 / 4 |
| Anthropic Opus 5.5 | 4 | 20 | 0.20 | 5 / 8 |
| Anthropic Fable 5.1 | 10 | 50 | 0.25 | 12.50 / 20 |
| Anthropic Haiku 4.5 (`20251001`) | 1 | 5 | 0.10 | 1.25 / 2 |
| OpenAI GPT-6.1 Sol | 2 | 10 | 0.10 | 2.50 |
| OpenAI GPT-6 Astra | 10 | 50 | 1 | 12.50 |
| OpenAI GPT-6 Luna | 0.10 | 0.50 | 0.01 | 0.125 |
| OpenAI GPT-5 Pro (legacy) | 15 | 120 | 15 | — |
| Gemini 3.8 Flash / 3.7 Flash | 0.75 | 3.75 | 0.075 | — |
| Gemini 3.1 Pro Preview | 2 | 12 | 0.20 | — |

Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[GPT-5 Pro](https://developers.openai.com/api/docs/models/gpt-5-pro), and
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Cache accounting follows
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching);
Gemini output limits include thoughts per the [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

For OpenAI GPT-6 requests above 272,000 input tokens, input, cache-read and cache-write
rates double, and output increases 1.5×. Gemini 3.1 Pro Preview above 200,000 input
tokens costs 4 input / 18 output / 0.40 cached input. Gemini 3.8/3.7 Flash promotional
rates end on 2026-12-31; from 2027-01-01 the table automatically uses 1.50 input /
7.50 output / 0.15 cached input.

## Reservation and actual spend

The default budget is $1 for every package. Every call, including a retry with error
feedback, must fit before any HTTP request is made. The input estimate counts one
token per UTF-8 byte of the entire serialized request (system prompt, schema, scoped
context and retry feedback included), plus 8,192 tokens for provider framing. This is
intentionally conservative; it is not the usual characters-divided-by-four heuristic.
The full source file retained locally for patch validation is excluded from requests.

Each request caps output at 8,192 tokens. The reservation uses the highest applicable
input/cache-write rate times estimated input, plus the capped output times its rate.
Long-context tiers apply to the estimate. Integer nanodollar accounting rounds up.
There are no hidden SDK retries. Missing usage after any HTTP failure, timeout or
malformed response retains the complete reservation; the report separates that amount
from spend confirmed by usage. API error bodies and authentication data are never
printed.

Actual cost comes from each response's usage: Anthropic regular input, cache reads,
5-minute/1-hour cache writes and output; OpenAI input, cached input, any cache-write
usage and total output (already includes reasoning); Gemini prompt/cache tokens and
candidate plus thinking tokens. Invalid or missing `submit_patch` is a paid failed
attempt and becomes retry feedback. No response text is treated as a patch.

Unknown model IDs use the maximum of every listed rate for that provider, including
long-context/cache-write rates, and print a warning. This still enforces the budget
against the checked-in table. The table must be maintained when prices change;
custom endpoints may charge different prices. The CLI cannot enforce an external
service's invoice or API contract. If returned usage exceeds the reserved token bounds,
it reports actual usage and stops all further calls instead of hiding the discrepancy.

## Live evaluation

The [storefront results](provider-evaluation.md) include verified zod/stripe runs for
all three providers, the Sonnet 4.6 versus 5.5 effort comparison, exact API-echoed model
IDs, and spend versus reservations. Sonnet 5.5 with `medium` effort is the Anthropic
default. Its $2 input / $10 output per MTok rates were checked against the
[Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
on 2026-10-04. The small fixture comparison does not establish a general quality ranking.

Offline CI replays wire fixtures, including a captured no-tool response. Live calls
are opt-in, with environment keys only. Build core first, then use the evaluation
helper against a clean, installed storefront checkout outside this repository:

```sh
pnpm --filter @uptide/core build
pnpm exec tsx scripts/eval-providers.ts --smoke --provider=anthropic
pnpm exec tsx scripts/eval-providers.ts --repo=/scratch/storefront --only=zod --provider=openai
pnpm exec tsx scripts/eval-providers.ts --repo=/scratch/storefront --only=stripe --provider=gemini
pnpm exec tsx scripts/eval-providers.ts --repo=/scratch/storefront --only=zod --provider=anthropic --model=claude-sonnet-5-5 --effort=high
```

Repeat both packages for each model/effort. `--effort=high` explicitly reproduces the
Sonnet 5.5 API default; omission uses Uptide's selected `medium` effort. Each run gets
an isolated clone. Only aggregate metrics are emitted by this helper; keep any full
local fix reports outside Git.
