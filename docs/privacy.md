---
title: Privacy
description: What Uptide runs locally, what leaves your machine and when, what it loads from your repository, and where the full isolation model is.
---

# Privacy

For anyone deciding whether to run Uptide on their code: what runs where, and what leaves
the machine. The isolation model and how to report a problem are in
[SECURITY.md](../SECURITY.md).

## The statement

This is the text `uptide --help` prints, word for word:

Analysis runs locally. Code snippets go to your chosen LLM provider (Anthropic, OpenAI or Gemini), only
for assisted fixes in `uptide fix`, and only with your own API key from ANTHROPIC_API_KEY,
OPENAI_API_KEY or GEMINI_API_KEY: for each
site the rules cannot migrate, the finding, the enclosing function and the compiler
error. `uptide fix --no-llm` turns assisted fixes off. No account.
`check` and `verify` load the `typescript` package your repository installs (resolved from its
node_modules) to compile with, and never run your repository's scripts or other code outside
`fix`'s verification step.
Anonymous telemetry is off by default and asks for consent in an interactive terminal.
Set UPTIDE_TELEMETRY=0 to disable it. No IP, code, paths or repo names are collected.
Other network use: your npm registry for package metadata and tarballs, npm's advisory
endpoint from `list` (public package names and installed versions; `--no-advisories` turns
it off), PostHog EU only
after telemetry opt-in, and GitHub when you pass `fix --pr` or run `pr` / `pr-body`.

## Command by command

There is no Uptide server. With telemetry off (the default):

| | Where it runs | What leaves your machine |
| --- | --- | --- |
| `list`, `plan` | locally | package names/versions requested from your npm registry, and `list` sends public packages' names and installed versions to npm's advisory endpoint; metadata only, no source code |
| `check` | locally | nothing of yours; it downloads package tarballs from your npm registry. No LLM call. It loads your installed `typescript` package to compile with, and runs no script or other code of yours. |
| `fix`, rules and verification | locally, in a temporary clone | nothing of yours |
| `fix`, assisted fixes | Your chosen provider's API, with **your** environment API key | per site no rule covers: the finding, the enclosing function or declaration, and the compiler error |
| `pr`, `fix --pr` | GitHub, through your own `gh` | the branch and the pull request, when you say so |

Without a key, or with `--no-llm`, those sites are listed for you instead.

## What runs from your repository

`check` runs none of your scripts or code. The one package it loads from your
`node_modules` is the `typescript` your repository installs, to compile with; the bundled
compiler stands in only when there is none. `fix` and `verify` work in a temporary clone,
install with lifecycle scripts disabled and git hooks off, and run your type-check, tests,
formatter and linter there: that verification step is the one place your code is executed,
and it is the point of the command. Tests that need a database, cache or queue do not run
unless you pass `--with-services --yes`, after Uptide prints what they would connect to.
Child processes for install and tests do not receive your LLM API key or GitHub token.

## Assisted fixes and telemetry

Assisted fixes send the finding, the enclosing code snippet and the compiler error to the
provider you chose (or your `OPENAI_BASE_URL`); your provider's data policy applies
([models](models.md)). Anonymous telemetry is opt-in, stored in PostHog Cloud EU with a
90-day retention policy, and contains no IP, code, paths, repository names or user names
([`uptide telemetry`](commands/telemetry.md); every field in [telemetry internals](telemetry.md)).

## Registry access

Registry settings use environment overrides, project and user `.npmrc` files, scoped
registries and host/path-scoped credentials. Credentials and registry responses are never
written to the discovery cache. Only packages served by the public npm registry are named to
npm's advisory endpoint; `--no-advisories` or `"advisories": false` in `uptide.config.json`
turns that request off ([`uptide list`](commands/list.md#registry-access-and-advisories)).
