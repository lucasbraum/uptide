---
"uptide": minor
---

`check` and `fix` upgrade a package together with the packages that must move with it,
using the groups `list` already draws (family, peer link, shared pin), each at the version
that agrees with the target. `fix ai` also bumps `@ai-sdk/react`, `@ai-sdk/provider` and the
installed `@ai-sdk/*` providers in one install and one commit; check's plan, the fix summary
and the PR description say which and why, and `fix` stops before changing anything when a
member has no release that agrees. npm and pnpm installs resolve the exact version first,
so a `^` range keeps the version the target pins. Ground-truth entries take `with`, the
packages the real upgrade moved, and `pack test` fails when check would leave one behind.
