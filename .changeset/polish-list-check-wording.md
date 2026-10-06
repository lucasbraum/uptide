---
"uptide": patch
---

Polish from a real run of `list` and `check`:

- A group mixing families is named after its hub, the package joining them that is nobody's
  peer (`ai + @ai-sdk/*`, `--group ai`), even when a family member is used in more files. Its
  target names each major when they differ (`→ ai 7 · @ai-sdk/* 4`) instead of a range.
- A group member's priority reads `<member> <reason>`, dev first: `dev · @eslint/js deprecated: …`.
- `check` states every analyzed package's verdict and what verified it, zero included:
  `0 breaking · compiled against 4.6.5: 0 new type errors`, or `types not verified: <why>`; in
  the terminal, the HTML report and JSON (`verdict`, and `compile.newErrors`).
- "by rule / by agent" reads "auto-fixable / need the agent (LLM)" in `check` and `plan`, and
  "auto-fixed / fixed by the agent (LLM)" in what `fix` did.
- Every suggested command is written the same way, `npx uptide …` (`npx uptide@next` from a
  prerelease), `list` included.
