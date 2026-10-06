---
"uptide": patch
---

`check` no longer overflows the call stack on packages whose declarations refer back to
themselves, such as pino 10's `declare namespace pino { export { pino as default, pino } }`
(#4). Extraction emits a name that reaches a declaration it is already inside, and stops
there, recorded as `recursive type pino (compared by name)`; walks nested deeper than 32
levels are cut the same way. The diff compares through those cuts by what they stand for, so
`pino.pino.stdTimeFunctions` is not reported as removed when `pino.pino` became `pino` itself.
