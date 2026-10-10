---
"uptide": minor
---

Plan peer blockers before cloning or installing, suggest explicit compatible peer upgrades, and add repeatable `--allow-peer` with visible package-manager overrides and PR risks. Reject npm lockfiles that disagree with committed manifests before starting a migration.

Collect peer blockers across the complete upgrade group and print one complete retry command. Include explicitly allowed peer packages in the old/new lockfile subtree union while retaining strict rejection of unrelated resolution changes.

Accept same-content lockfile deduplication and descriptive metadata updates only when outside resolutions stay identical, and disclose accepted housekeeping in the fix report and PR description.
