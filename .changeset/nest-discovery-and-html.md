---
"@uptide/core": patch
"uptide": patch
---

Correct dependency discovery for NestJS and other script/config-driven projects: separate tooling and required peers from possibly unused packages, group lockstep and peer-coupled upgrades, count imported value references, hide zero-count symbols, show major-version gaps, and omit workspace columns in single-package repositories.

Add `uptide list --html [--open]` using check's report template and styling, with group check commands, copy buttons and collapsed tooling/possibly-unused sections. Reports exclude source code and local paths by default; `--details` adds file lists. Add a synthetic single-package pnpm NestJS regression fixture.

Add scope/lead-package group names and `check --group` expansion, peer member labels, width-aware terminal columns and details-only symbols. Share an offline light/dark report design between list and check with one command per group, responsive rows and private default output. Read the installed CLI version for report headers, including when a package is versioned after bundling.

Count only visible upgrade groups in list summaries, reserve scope titles for the primary
lockstep set, and use unique lead-package selectors for independent groups. Align terminal
version arrows and show only target ranges in group headers. Keep standalone HTML copy
actions in the package row with accessible command labels and manual-copy fallback.
