# Provider protocol fixtures

The Anthropic, OpenAI, Chat Completions and Gemini success fixtures are synthetic
wire responses based on official schemas, replayed offline with mocked HTTPS.

`anthropic-no-tool.json` is a live Claude API capture from 2026-10-04 using
`claude-sonnet-5-5` with a deliberately restricted 16-token output cap. The response
ended at `max_tokens` without a tool call. It tests a paid failed attempt, explicit
retry feedback and budget accounting. It is a controlled truncation case, not a
measurement of normal no-tool-call frequency. Authentication headers, request IDs,
thinking/signature blocks and unrelated metadata are not retained. Only public
synthetic smoke input was sent. Tests make no live calls.
