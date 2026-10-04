# Live provider evaluation

Measured 2026-10-04 against the public storefront fixture. Each run used a fresh
isolated clone of the same baseline and a $1 package budget. Targets: zod 4.6.5 and
stripe 23.0.0. Dependency installation used lifecycle scripts off. Credentials were
read from process environment only; no keys, request headers or raw API errors are
included here. These are single trials, with some runs concurrent, not a general
model quality or latency benchmark. Wall time includes clone, analysis, install,
agent calls and verification.

“Verified” requires both compiler and fixture tests to pass through the existing
publish gate. Successful zod runs fixed 25 mechanical + 4 agent sites (5 tests);
successful Stripe runs fixed 3 mechanical + 3 agent sites (3 tests). Attempts are
provider requests, including rejected patches and HTTP/transport failures; one accepted patch may
resolve several sites. Cost is calculated from returned usage and the dated standard
price table, not an invoice; this also applies to Gemini's free-tier calls.

Reservation is the sum of individual pre-call worst-case bounds, not actual spend or
a permanently withheld total. Reported usage settles each reservation. “Unknown”
is the retained reservation for calls with no trustworthy usage; it still counts
against the $1 ceiling. No run exceeded its budget.

## Storefront runs

| Provider / model | Effort | Package | Verified | Agent sites | Attempts | Spend USD | Reservations USD | Unknown USD | Seconds |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| anthropic / `claude-sonnet-4-6` | API default | zod | pass | 4 | 2 | 0.017802 | 0.383094 | 0.000000 | 42.90 |
| anthropic / `claude-sonnet-4-6` | API default | stripe | pass | 3 | 3 | 0.033366 | 0.609168 | 0.000000 | 58.93 |
| anthropic / `claude-sonnet-5-5` | API default (high) | zod | pass | 4 | 2 | 0.015734 | 0.255220 | 0.000000 | 40.46 |
| anthropic / `claude-sonnet-5-5` | API default (high) | stripe | pass | 3 | 2 | 0.024752 | 0.271184 | 0.000000 | 51.89 |
| anthropic / `claude-sonnet-5-5` | medium | zod | pass | 4 | 2 | 0.013244 | 0.255508 | 0.000000 | 38.59 |
| anthropic / `claude-sonnet-5-5` | medium | stripe | pass | 3 | 2 | 0.021592 | 0.271472 | 0.000000 | 49.69 |
| openai / `gpt-6.1-sol` | API default | zod | pass | 4 | 2 | 0.006806 | 0.221363 | 0.000000 | 36.74 |
| openai / `gpt-6.1-sol` | API default | stripe | pass | 3 | 3 | 0.018677 | 0.348145 | 0.000000 | 47.80 |
| gemini / `gemini-3.8-flash` | API default | zod | fail (service errors) | 0 | 12 | 0.000000 | 0.473886 | 0.473886 | 126.27 |
| gemini / `gemini-3.8-flash` | API default | stripe | fail (service errors) | 1 | 7 | 0.004965 | 0.287397 | 0.246836 | 154.88 |

The first Gemini zod run received eleven HTTP 503 responses and one HTTP 429; Stripe
received one HTTP 200, four 503s and two 429s. Rate limits honored `Retry-After`, defaulting to 60 seconds when absent, before
retrying. These runs did not verify; the publish gate stayed closed. They demonstrate
service unavailability/rate limiting, not an invalid model ID or failed tool protocol.
The smoke and Stripe's successful call both echoed `gemini-3.8-flash`.

The serial reruns also failed verification after waiting and retrying:

| Model | Package | Verified | Agent sites | Attempts | Spend USD | Reservations / unknown USD | Seconds | Responses |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `gemini-3.8-flash` | zod | fail | 0 | 12 | 0.000000 | 0.473901 | 359.99 | 7 × HTTP 503, 5 × HTTP 429 |
| `gemini-3.8-flash` | stripe | fail | 0 | 9 | 0.000000 | 0.368667 | 223.80 | 1 × HTTP 429, 8 transport failures without an HTTP response |

No model ID or token usage was returned in these serial reruns. The zero confirmed
spend is not a claim of zero possible billing: every failed request kept its full
reservation. Zod retained four compiler errors; Stripe retained three (its three tests
passed, which alone cannot pass verification). Gemini migration quality remains
unmeasured under successful service conditions; a live rerun is needed when the free
tier is available. These are not classified as adapter protocol failures.


## Anthropic choice

| Model / effort | Agent sites (zod + Stripe) | Attempts | No-tool calls / attempts | Spend USD | Seconds |
| --- | ---: | ---: | --- | ---: | ---: |
| `claude-sonnet-4-6` / API default | 7 | 5 | 0 / 5 | 0.051168 | 101.82 |
| `claude-sonnet-5-5` / API default (high) | 7 | 4 | 0 / 4 | 0.040486 | 92.34 |
| `claude-sonnet-5-5` / medium | 7 | 4 | 0 / 4 | 0.034836 | 88.28 |

Select **Sonnet 5.5 with `medium` effort**: equal sites and verification, no skipped
tool calls, one fewer attempt than 4.6, and lower cost/time in this small sample.
The high-effort comparison omitted `output_config`, preserving 5.5's documented API
default (adaptive thinking, high effort). The medium trial explicitly set
`output_config.effort=medium`. Thinking itself was left at the API default in both.
Sonnet 4.6 remains selectable and retains forced tool use. The sample is too small
to estimate a reliable general no-tool-call rate.

## Protocol smokes

Every smoke returned HTTP 200 and exactly one valid `submit_patch`, in one attempt.
Model IDs below are the exact strings echoed by the APIs (also matching the requested
IDs). No 429 occurred in these minimal calls.

| Echoed model ID | Effort | Spend USD | Reservation USD | Seconds |
| --- | --- | ---: | ---: | ---: |
| `claude-sonnet-4-6` | API default | 0.00379500 | 0.18437400 | 9.20 |
| `claude-sonnet-5-5` | API default | 0.00261400 | 0.12282800 | 5.72 |
| `claude-sonnet-5-5` | medium | 0.00261400 | 0.12297200 | 2.48 |
| `gpt-6.1-sol` | API default | 0.00112800 | 0.10769250 | 3.86 |
| `gemini-3.8-flash` | API default | 0.00068175 | 0.03843075 | 3.23 |

A separate controlled Sonnet 5.5 call capped output at 16 tokens to capture a real
no-tool response for offline regression testing. It echoed `claude-sonnet-5-5`, ended
at `max_tokens`, and reported 757 input / 16 output tokens ($0.001674). It is excluded
from the normal no-tool frequency above. CI checks that it consumes an attempt and
budget, adds “respond only by calling submit_patch” feedback, and can recover on a
valid subsequent response. Successful protocol fixtures are synthetic; this truncated
response is a sanitized live capture.

## Reproduction and sources

Build core and use `scripts/eval-providers.ts` with `--smoke`, or `--repo` plus
`--only=zod|stripe`. Provider/model overrides and `--effort=high|medium|low` allow
controlled comparisons. API keys come only from environment variables. See
[model pricing](model-pricing.md) for commands and exact budget accounting.
Initial harness setup errors occurred before any API call and cost $0; the helper
was corrected to import built core so worker entry points resolve.

Official documentation checked 2026-10-04:

- [Sonnet 5.5 model ID and $2/$10 pricing](https://platform.claude.com/docs/en/models/sonnet-5-5/overview).
- [Sonnet 5.5 adaptive thinking, effort and auto/strict tool calling](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).
- [Claude model IDs](https://platform.claude.com/docs/en/models/overview).
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [function calling](https://developers.openai.com/api/docs/guides/function-calling).
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) and [API error guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).

Custom `OPENAI_BASE_URL` uses Chat Completions, tested offline against a protocol
fixture. The official OpenAI default uses Responses and was verified live above.
Custom deployments remain **compatible, not verified**.
