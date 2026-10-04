---
"@uptide/core": patch
"uptide": patch
---

Correct dependency discovery for NestJS and other script/config-driven projects: separate tooling and required peers from possibly unused packages, group lockstep and peer-coupled upgrades, count imported value references, hide zero-count symbols, show major-version gaps, and omit workspace columns in single-package repositories.

Add `uptide list --html [--open]` using check's report template and styling, with group check commands, copy buttons and collapsed tooling/possibly-unused sections. Reports exclude source code and local paths by default; `--details` adds file lists. Add a synthetic single-package pnpm NestJS regression fixture.
