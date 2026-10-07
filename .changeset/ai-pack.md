---
"uptide": minor
---

A verified migration pack for the AI SDK (`ai`) 6 → 7: the renamed options (`system` →
`instructions`, `onFinish` → `onEnd`, `onStepFinish` → `onStepEnd`, `experimental_telemetry`
→ `telemetry`), `stepCountIs` → `isStepCount`, `fullStream` → `stream`, `totalUsage` → `usage`
and the removed `experimental_*` options are rewritten by rule; telemetry `metadata`, tool
`context` and the stream result helpers go to the agent with the guide; what the compiler
cannot see (telemetry registration, results that now cover every step, rejected system
messages) is listed for review. Scored against vercel/chatbot and miurla/morphic at the
commit before their own upgrade: no false positive. `uptide pack test` gains
`--update-fixtures`, fixture markers take the compiler's `message`, and ground-truth
repositories can use bun.
