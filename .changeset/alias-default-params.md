---
"uptide": patch
---

`check` no longer dies with "Manipulation error: A syntax error was inserted." on packages
whose type aliases give their type parameters defaults (`type-fest` 4 → 5, `i18next` 23 → 26):
the alias body is read after the parameter list, not at the first default's ` = `, so these
aliases are compared by the checker instead of breaking the comparison program.
