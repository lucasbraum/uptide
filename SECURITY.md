# Security

Uptide reads your source, installs a dependency and runs your tests. This page says what it
isolates, what it does not, and how to report a problem.

## Isolation model

**`uptide check`** runs none of your repository's scripts or code. It reads your files and
lockfile, downloads the installed and the target version of the dependency from your npm
registry as tarballs (no install, no lifecycle scripts), compiles your code against the
target in memory, and loads the two versions of the *dependency* in a sandboxed Node process
to compare runtime behavior. It makes no LLM call. To compile, `check` (like `verify`) loads
the `typescript` package your repository installs, resolved from its `node_modules` (the
nearest one above the workspace; never `NODE_PATH` or a global install), in Uptide's own
process; the bundled compiler is used only when the repository installs none. That package is
the one thing from your `node_modules` that `check` loads, and it is the compiler your own
build already runs.

**`uptide fix`** and **`uptide verify`** work in a temporary clone, never in your checkout:

- The clone lives in Uptide's own directory under the OS temp directory. It is removed when
  the run ends and kept (its path printed) only when the run fails or you pass `--keep`.
  Uptide deletes nothing outside that directory.
- Your branch, working tree, git config and git hooks are compared before and after the
  run and must be identical. You receive the result as a branch ref plus a stored run
  inside `.git/uptide/`.
- The dependency is installed by your package manager with lifecycle scripts disabled.
  The resulting lockfile is rejected if anything outside the upgraded dependency's subtree
  changed.
- Git hooks are disabled for every command Uptide runs.
- Verification runs **your code**: your type-check, your tests, your formatter and linter,
  inside the clone. This is the one place repository code is executed, and it is the point
  of the command. The type-check loads the clone's installed `typescript` package, as
  `check` does, and compiles with it in Uptide's process; no script of yours runs for it. Tests that need a database, cache or queue do not run unless you pass
  `--with-services --yes`, after Uptide prints what they would connect to.
- Child processes for install and tests do not receive your LLM API key or GitHub token.

**Network.** Your npm registry, for metadata and tarballs. npm's bulk advisory endpoint, from
`list`, with the names and installed versions of packages served by the public npm registry
(never a package from another registry or scope; `list --no-advisories` or `"advisories": false`
in uptide.config.json turns it off). The chosen Anthropic, OpenAI or Gemini API, only for
assisted fixes in `fix`, only with your own environment API key, and never with `--no-llm`:
the request carries the finding, the enclosing function or declaration and the compiler
error for one site at a time. GitHub, through your own `gh`, only when you pass `--pr` or
run `uptide pr` / `uptide pr-body`. No account or Uptide server.
Anonymous telemetry is off by default; opt-in sends only the fields documented in
[docs/telemetry.md](docs/telemetry.md) to PostHog EU. No IP, code, paths or repo/user names
are collected. `UPTIDE_TELEMETRY=0` always disables it.

**Not a sandbox.** Uptide does not contain a malicious repository: `fix` runs that
repository's tests with your user's permissions, as you would. Run it on code you would
run yourself. The dependency being upgraded is treated as untrusted (no lifecycle scripts,
sandboxed probes); your own repository is not.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting on this repository:
**Security → Report a vulnerability**. Include the Uptide version (`uptide --version`), the
command, and what happened that the model above says should not.

You will get an answer within 7 days. Fixes are released under the `next` dist-tag first
and credited to you unless you prefer otherwise.

Reports that matter most: anything executed during `check` beyond loading the repository's
installed `typescript` package; a lifecycle script or git hook
that ran; a write outside the temporary clone or `.git/uptide/`; code sent anywhere other
than described above; a secret reaching a child process.

## Supported versions

The latest release on the `latest` and `next` dist-tags.
