---
"uptide": minor
---

Support Anthropic, OpenAI and Gemini assisted fixes with provider/model selection, environment-only credentials, and a strict pre-call cost budget (default $1 per package). Keep the same patch verification and publish gate; add privacy-safe provider/model telemetry and documented model pricing.

Select Sonnet 5.5 with medium effort after live storefront evaluation. Respect model-specific tool capabilities, retry rate limits within budget, and use Chat Completions for custom OpenAI-compatible endpoints.
