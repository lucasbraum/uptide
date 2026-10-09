# Uptide documentation

For anyone running Uptide on a repository (the first section) and for anyone changing Uptide
itself (the second). Start with [getting started](getting-started.md).

## Using Uptide

`uptide --help` and `uptide <command> --help` are the authority on flags; these pages add
what help cannot show.

| Page | What it answers |
| --- | --- |
| [Getting started](getting-started.md) | Install nothing, run the four commands, what Uptide needs from your repository |
| [Concepts](concepts.md) | Tiers, what "breaking" means, the coverage line, exit codes |
| [`uptide list`](commands/list.md) | Discovery: priorities, groups, usage counts, what the scan reads |
| [`uptide check`](commands/check.md) | What an upgrade breaks at your call sites, the HTML report |
| [`uptide plan`](commands/plan.md) | The order to upgrade in, with the effort each one takes |
| [`uptide fix`](commands/fix.md) | A verified migration on a new branch, step by step; `verify` and `clean` |
| [`uptide pr`](commands/pr.md) | Pushing a finished branch and its pull request description; `pr-body` |
| [`uptide telemetry`](commands/telemetry.md) | The opt-in, the switches, what an event contains |
| [Models](models.md) | Providers, defaults, `--max-cost`, `OPENAI_BASE_URL` |
| [CI](ci.md) | Checking and migrating Renovate and Dependabot pull requests with the GitHub Action |
| [Privacy](privacy.md) | What runs where, what leaves your machine, and the isolation model |
| [Troubleshooting](troubleshooting.md) | Yarn PnP, bun lockfiles, proxies and corepack, memory limits, "advisories not checked" |
| [FAQ](faq.md) | Renovate and Dependabot, where code goes, packages without a pack, pushing |

## Contributing and internals

| Page | What it holds |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Setup, the rules that do not bend, writing a pack, sign-off |
| [Migration packs](packs.md) | The public pack contract, ground truth, scoring, `uptide pack` |
| [Architecture](architecture.md) | How the engine works: discovery, the check pipeline, diff semantics, packs |
| [Decisions](decisions/) | Why things are the way they are, one record per decision |
| [Development](development.md) | Evaluation and release tooling |
| [Releasing](releasing.md) | How releases happen, the emergency dry run, one-time setup |
| [Priorities](priorities.md) | The rules and weights behind PRIORITIES in `uptide list` |
| [Telemetry internals](telemetry.md) | Exact event fields, local files, delivery, release configuration |
| [Package-manager smoke](npm-yarn-smoke.md) | The packed CLI on npm, pnpm and Yarn fixtures in clean containers |
| [Provider evaluation](provider-evaluation.md) | The measured storefront comparison of Anthropic, OpenAI and Gemini |
| [Model pricing](model-pricing.md) | Rates, token estimation and the scope of budget accounting |
| [Security](../SECURITY.md) | The isolation model and how to report a vulnerability |
