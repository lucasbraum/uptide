---
title: uptide list
description: Fast discovery of outdated dependencies, what to upgrade first and why, with no install, compile or execution of your code.
---

# `uptide list`

For anyone opening a repository and asking what is behind and where to start. `uptide list
--help` lists the flags; this page says what the output means and what the scan reads.

## What it shows

Fast discovery with no compile, install, tarball downloads or execution of repository code.
Requires a lockfile (exact manifest versions also work once the repository is detected).
Shows every outdated direct dependency once, current → latest, major/minor/patch (including
`2 majors behind` for 10 → 12), verified/generic tier, importing files, calls and references,
and nonzero top symbols. Workspaces on different versions share one row
(`5.0.52, 7.0.59 → 7.0.128`, past two versions the oldest and newest), its last column saying
`2 versions in 3 workspaces` (under the row when the terminal is too narrow), and usage is
counted once across the repository. Workspace columns appear only in workspace repositories.

**PRIORITIES** come first, in two tiers, each row with a one-line reason and the command to
run. **Urgent** (up to five rows, all with `--all`): known advisories for the installed
version, with its smallest fix (`fixed in 3.2.5 (patch, same major)`, `needs 4.1.11
(major)`), and a deprecated version. **Worth planning**, collapsed to its count until
`--all`: a major line with no release in a year, version drift (workspaces on different
majors of one package), a peer range holding another upgrade back, two or more majors
behind. Runtime dependencies rank before dev-only ones (`dev · ` in the reason); cheaper
upgrades come first among equals. When nothing is urgent it says so and suggests the cheap
batch of minor/patch upgrades that touch few files. The rules and weights are in
[priorities](../priorities.md); nothing in `list` calls an LLM.

**Groups** follow, with a command such as `uptide check --group nestjs` to check their
members together: a scope is one family (`@radix-ui/*`) whatever its members' versions, and
packages also group across scopes when a peer range of one's latest version needs the other,
or when both pin the same exact version of a dependency (`ai + @ai-sdk/*`). Each group says
why. Names use the family or lead package; external peers are members labeled `peer of
<package>`. Each member keeps its own classification and evidence. A group header follows its
lead; members with independent usage appear in their own section, and the group command and
JSON still include the complete member list. `uptide check --group nestjs` discovers and
expands the exact member list before checking; JSON retains each member, the stable group
selector and peer relationships.

Other rows put majors first, then importing files and call sites. Each row gives current →
latest, upgrade kind and major gap, verified/generic tier, importing files, calls, references
and top symbols. Terminal rows align to the available width; names are never truncated (a
name past 45 characters gets its own line) and narrow terminals omit trailing columns
instead. Top symbols are hidden until `--details`. Only verified packages carry a tier tag;
generic is the default. Color is disabled for pipes, `NO_COLOR`, `--no-color` and CI.

Minor/patch upgrades, tooling and possibly unused packages are collapsed; `--all` expands
them. Expanded rows explain the evidence; "possibly unused" means no usage was found by
Uptide's scan, so verify before removing.

## Flags

- `--all`: expand minor/patch rows, tooling and possibly unused packages.
- `--json`: every row, group, classification reason and discovery failure. `--json` has one
  entry per package: `versions` lists every installed version with its workspaces when they
  differ, `current` is the oldest outdated one, and `usage` is counted once.
- `--html [path]`: write a local HTML report with check's template, styling and copy buttons.
  By default it lives beside check reports in the OS temporary `uptide` directory; its path
  is printed to stderr. Nothing is generated without this flag. JSON stdout stays pure. HTML
  shows all upgrade rows, with tooling and possibly unused packages in collapsed sections,
  and a copyable check command per row; no source code or file paths by default.
- `--open`: with `--html`, open the page in an interactive terminal (never in CI or a pipe).
- `--details`: include top symbols and source file lists. HTML includes no source code, file
  paths or workspace paths by default; commands without `--details` should be run from the
  named repository.
- `--no-advisories`: never send installed versions to npm's advisory endpoint; the PRIORITIES
  heading says "advisories not checked". `"advisories": false` in `uptide.config.json` does
  the same for everyone in the repository.
- `--verbose`: phase timings and file counts on stderr (below).
- `--cwd <dir>`, `--ci`, `--no-color`: shared options.

## Tooling and possibly unused packages

Tooling is separate and collapsed: script commands and package bins, known build/config
tools, packages referenced in configuration, types for used runtime packages (and Node), and
peers of used packages. Compilers and bundlers (`typescript`, `@swc/core`, `esbuild`,
`@babel/core`, `vite`, `webpack`) are tooling even when a script imports them, and a new
major of one is shown under TOOLING even while it is collapsed (`compiler major: check build
and tsconfig`). Only the remaining packages without source imports are "possibly unused".

Tools used by scripts and configs, runtime types and required direct dependencies and peers
are classified separately from possibly unused packages. This includes package.json tool
settings (including keys matching dependency names), tool rc file presence, installed bin
names (including collisions), hook/task commands, Karma plugin mappings and auto-loading,
stylesheet imports and HTML assets under `node_modules`. Legacy lint-staged `linters` maps
and current flat glob maps both supply commands; their `ignore` entries are neither commands
nor source-scan exclusions. Configuration is read as data, never executed; local installed
metadata is preferred for bins and peers, with registry metadata as a fallback.

## Registry access and advisories

Registry settings use environment overrides, project and user `.npmrc` files, scoped
registries and host/path-scoped credentials. Known advisories come from one request to npm's
bulk advisory endpoint with the names and installed versions of packages served by the public
npm registry; packages from another registry or scope are never sent there. A failure or
timeout (5 s) says "advisories not checked" and never fails the run. An advisory row names
its smallest fix (same major or not). Publish dates for the support window come from the full
registry document of packages with a newer major, under the same 5-second deadline.

Discovery otherwise uses abbreviated metadata with up to 16 concurrent requests, a 10-second
timeout per attempt (including response bodies), and one retry for timeouts or HTTP 5xx. Only
a host that returns 401, 403 or 405 is blocked for the rest of that run. Credentials and
registry responses are never written to the discovery cache. Unresolved packages stay in
JSON's `unknown` list, the summary reports the shared reason (for example "3 not checked
(access denied)") or simply "N not checked" for mixed reasons, and HTML keeps one named row
per incomplete package. Repeated failures are grouped by host and reason (more than five
network errors, or multiple access failures); `--details` lists names. Successful packages
remain visible; incomplete discovery exits 2. Analysis commands retain their normal retry
policy.

Git/GitHub, local file/link/workspace dependencies and HTTP(S) sources are intentional skips,
including `npm:` aliases pointing to those sources. They appear as collapsed "not checked:
non-registry source (github)" lines (expand with `--all` or `--details`) and a collapsed HTML
section; JSON keeps them in `skipped`. They do not make discovery incomplete or change exit
0. Registry aliases resolve the real package name, retaining their local dependency names for
usage scanning and adding `registryName` to aliased upgrade rows in JSON. Internal workspace
dependencies and local/git/URL specifiers are excluded from registry queries.

## What the scan reads

Usage is syntactic: syntax scanning includes imports, re-exports, `require`, import-equals,
literal dynamic imports and JS/TS/JSX/TSX. Calls/new/JSX and non-call references are
separate counts; passing a binding as a value, such as `app.register(cookie)`, counts as a
reference. Indirect aliases and reflection are not followed. Counts are repository-wide,
once per package, when several workspaces lock different versions.

The scan skips only `node_modules`, `.git`, `coverage`, `dist`, `build`, `bower_components`,
`vendor`, generated-file patterns (`*.min.js`, `*.bundle.js`, `*.map`), and root/nested
`.gitignore` rules. Git patterns are relative to their declaring directory and support
negation. Tool scopes (`.prettierignore`, `.eslintignore`, `.stylelintignore`,
`standard.ignore`, lint-staged `ignore`) do not exclude application code: files a formatter
or linter skips may still use dependencies. A dependency-name text gate and lexer select
candidates for full syntax parsing; bindings, shadowing, calls and references still use the
syntax parser. Large batches (at least 32 candidates / 8 MB) use up to four CPU workers;
smaller batches avoid worker startup overhead.

If Git rules exclude **more than 50%** of candidate application JS/TS files, the summary,
HTML and `--verbose` warn with the matching patterns and counts. JSON includes
`scanWarnings`; a usage warning alone does not change the exit code. Candidates exclude
built-in/generated artifacts, declaration files and tool configs, and are counted before
dependency text/lexer filtering. Git-ignored subtrees get a filename-only audit without
reading or parsing source; built-in excluded directories are never enumerated. Verbose output
shows candidates, excluded sources, parsed files, workers and per-reason skip counts.

## `--verbose`

`list --verbose` prints phase timings and file counts to stderr: manifest read, registry,
source scan, config scan and render. Source scan includes file traversal and stylesheet/HTML
assets; config scan includes configuration parsing and classification. Render covers
terminal/JSON and optional HTML writing, excluding browser launch. With `--json`, verbose
phase/count data is also included under `timing`; default JSON stays unchanged. This helps
distinguish registry latency from repositories with many source/config files.

## Exit codes

**0** discovery complete; **2** bad arguments, unsupported repository, no network, or
incomplete discovery (successful rows are kept). See [concepts](../concepts.md#exit-codes).
