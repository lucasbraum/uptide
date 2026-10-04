# GitHub Action: Renovate and Dependabot pull requests

Use [the example workflow](../examples/uptide-workflow.yml), pinning a reviewed commit of `uptide-dev/uptide`. It checks same-repository bot PRs on `pull_request`
`opened`/`synchronize`, detects zod/stripe upgrades from manifests, catalogs and lockfile
importers, and maintains one sticky findings comment. `only` selects dependencies;
`paths` selects repository-relative source directories/globs.

`fix: 'true'` plus `anthropic-api-key` enables migration. Comparison uses **PR-head
source with the base dependency graph** in a temporary worktree. Final verification
uses the actual PR-head manifests/lockfile; only source patches are transferred. A
passing migration pushes **one commit on the existing PR branch**. Manual sites,
failed tests/types, or a changed PR head prevent publication. No force-push or merge.
Current migration support is TypeScript, zod and stripe, using npm, pnpm or Yarn with node_modules. Missing workspace test
scripts are reported, not claimed as passing tests. Code context may be sent to
Anthropic only in assisted mode. Install/test children receive no API/token secrets.

Use `contents: write` and `pull-requests: write`, `persist-credentials: false`, and the
same-PR concurrency group shown in the example. Dependabot PRs normally receive a
read-only `GITHUB_TOKEN` and do not receive ordinary Actions secrets: configure the
key and an appropriately scoped write token as **Dependabot secrets**, or run in a
maintainer-controlled workflow. Do not change to `pull_request_target` to bypass
this boundary. Fork PRs are skipped. See [GitHub's Dependabot restrictions](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions).

```sh
pnpm eval:action  # local GitHub API simulation + real check/fix/tsc/tests/git remote
```

This creates an isolated demo repository and bare local remote under `eval-out/`,
with a zod 3 baseline, a Renovate-style bump branch, and the verified migration result.
It also proves that a final-verification failure cannot push. The generated README
contains commands to publish your throwaway repository. **No hosted GitHub run or PR
is created by this evaluation.** The real workflow requires a bot-authored PR; a
human-authored imitation is intentionally rejected.

## Discovery before analysis

For a repository-wide inventory run `npx uptide list --json`; this needs no installed
dependencies. Locally use `npx uptide list` → `npx uptide check <pkg>` →
`npx uptide fix <pkg>`. The Action already selects the dependency names and targets
from the upgrade PR before calling the core check; it never performs an implicit
whole-repository check. Its automatic migration path remains limited to verified packs.
