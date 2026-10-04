---
"@uptide/core": minor
"uptide": minor
---

Split fast dependency discovery (`uptide list`) from explicit analysis (`uptide check <package...>`). Check now requires package names and removes the implicit time budget. Plan uses discovery plus optional saved check results, with unknown effort until analyzed. Add positional fix names, memory-aware workspace scheduling, root-cause grouping and clear per-package recursion failures.
