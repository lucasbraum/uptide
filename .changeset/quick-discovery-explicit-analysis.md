---
"uptide": minor
---

Split fast dependency discovery (`uptide list`) from explicit analysis (`uptide check <package...>`). Check now requires package names and removes the implicit time budget. Plan uses discovery plus optional saved check results, with unknown effort until analyzed. Add positional fix names, memory-aware workspace scheduling, root-cause grouping and clear per-package recursion failures.

Scope named checks and baseline compilation to importing files and their reachable dependencies. Calibrate memory estimates to that graph, use the full reservation for serial work, and retry parallel memory failures serially before skipping. Expand grouped root-cause locations only in detailed output.
