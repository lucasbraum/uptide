# Migration packs: the public contract

A migration pack is everything Uptide knows about upgrading one dependency across one
breaking change. This page is the contract a pack meets, with the zod pack
(`packages/core/src/packs/zod/`) as the reference. Anyone can write a pack, and so can a
scheduled agent: `uptide pack new` scaffolds one and `uptide pack test` scores it. The
contract is checked in code (`packages/core/src/packs/contract.ts`), not only described here.

The step-by-step guide is in [CONTRIBUTING.md, "Write a pack"](../CONTRIBUTING.md#write-a-pack).
The next packages worth a pack are in [`packs/queue.json`](../packs/queue.json).

## What a pack is

A pack is a directory `packages/core/src/packs/<name>/`:

| File | What it holds |
| --- | --- |
| `index.ts` | the pack: metadata, rules, behavior notes, agent instructions |
| `fixtures/<case>/before.ts`, `after.ts` | code before and after the rules, with the sites marked |
| `<name>.test.ts` | runs the fixtures under `pnpm test` (scaffolded) |
| `ground-truth.json` | real public repositories at a pinned commit, with the findings expected there |
| `verification.json` | what `uptide pack test --write` measured; the status the CLI shows |

It is registered in `packages/core/src/packs/registry.ts`, which `uptide pack new` writes.

### Metadata

```ts
meta: {
  package: 'zod',
  from: '>=3 <4',     // installed versions it migrates from (semver range)
  to: '>=4 <5',       // target versions
  sources: [{ title: 'Zod 4 migration guide', url: 'https://zod.dev/v4/changelog' }],
  maintainer: 'uptide-dev',
},
```

`sources` are the changelog and migration guide every rule and note is taken from. A rule
that no source supports does not belong in a pack. `supports(from, to)` defaults to the two
ranges; a pack may narrow it (stripe also requires the target to be newer than what is
installed).

A pack may also name `companions`: packages that always move with the package, even when
their installed version already accepts the target.

```ts
companions: [{ name: 'ai-sdk-ollama', source: 'https://github.com/jagreehal/ai-sdk-ollama/blob/main/README.md' }],
```

**Companions come from official docs, never from ground truth alone.** `source` is the `https`
URL of the official migration guide or changelog that says the package moves with the
package: the leader's documentation or the companion's own, never the ground truth. A
ground-truth repository that moved a package shows what one repository did, not that the
package must move. `uptide pack test` fails a pack whose `companions` has an entry with no
`source`, one that is not an `https` URL, or one that names the pack's own package.

A release-group member published at the target's own version (`react-dom`) and `@types/*`
need no entry. A package that only peers on the package and whose installed range rejects the
target is left in place and listed under possible impact as a peer conflict; it is never
compiled at another version.

### Mechanical rules: detect and rewrite

```ts
{
  id: 'error-params',
  summary: 'required_error and invalid_type_error become one error callback',
  severity: 'breaking',                 // or 'deprecated'
  kinds: ['signature', 'type', 'required'],
  symbols: /string|number|.../,         // detect: the findings `check` reports that it claims
  guide: zodGuide.errors,               // what the agent is told at a site the rule cannot rewrite
  rewrite: (text, finding) => ...,      // the edit at one reported site, or { applied: false, reason }
}
```

- **Detect.** `check` already diffs the two versions' declarations and compiles the
  repository against the target. A rule claims the findings whose change kind and symbol
  path it matches (`kinds`, `symbols`), and, with `message`, what the compiler said there: a
  compiler-only finding's path is just its code (`TS2353`), the message names the property.
  The plan files every claimed site under the rule, whether or not it rewrites (`ruleOf`). For sites no type diff reports, a rule can add
  `detect(text, file)`, which returns sites found in the source of a file that uses the
  package; `check` lists them as the pack's own findings.
- **Rewrite.** `rewrite(text, finding, context)` edits the reported site and nothing else,
  or declines with a reason (`existing error/errorMap needs manual merging`). A rule without
  `rewrite` is assisted: the agent gets its `guide`, and a patch is kept only when the
  site's compiler error disappears and no new one appears.
- A rule never changes behavior silently. When behavior can differ, it is a behavior note
  (below), reported and left to a person.

`definePack` (in `contract.ts`) builds the runner's hooks from rules and notes alone, which
is what `uptide pack new` scaffolds. `replaceAtSite(text, finding, before, after)` is the
common rewrite: one identifier at the reported site. Zod and Stripe implement the same
interface by hand because they gather context no rule has (default messages, API versions).

### Fixtures

Every rule that rewrites or detects has fixtures, and every fixture case has a site it must
leave alone. A site is a line that ends in a marker comment:

```ts
export const name = z.string({ required_error: 'Name is required' }); // @uptide error-params at:z.string
export const merged = z.string({ required_error: 'x', errorMap: m }); // @uptide error-params keep at:z.string
export const contact = z.string().email(); // @uptide string-format at:.email( path:ZodString#email
```

- `keep`: the rule must leave this site alone (a rewrite must decline, `detect` must not find it).
- `at:<text>`: where on the line the site starts, as `check` would report it (default: the
  first non-blank column).
- `kind:<kind>`, `path:<path>`: the change `check` reports there, when the rule matches on
  them (default: the rule's first kind, and the `at:` text).
- `message:"..."`: the compiler's message there, for a rule that matches on `message`.

Each marked site of a rule with `rewrite` is rewritten, bottom-up, and the result must equal
`after.ts` byte for byte (the markers are comments, so they stay). A rule or note with
`detect` must find exactly the marked lines in `before.ts`, and nothing on any other line.
Fixtures are test data: biome and `tsc` skip them, and they are never reformatted.
`uptide pack test <package> --fixtures-only --update-fixtures` writes each `after.ts` from
what the rules produce, like a snapshot update: read the diff before committing it.

### Behavior notes: what the compiler cannot see

```ts
behavior: [
  {
    id: 'default-messages',
    summary: 'Zod 4 words its default error messages differently; code and tests matching the old text keep compiling',
    reported: ['decision', 'test-follow-up'],
  },
],
```

A behavior note is a change where the same code compiles and does something else. How a
site is reported is part of the contract (`reported`):

- `finding`: `check` lists the site as the pack's own finding (evidence `pack`), found by
  the note's `detect`; `fix` never edits it unasked. Example: a Stripe client created
  without `apiVersion`, whose API version the SDK bump changes at runtime.
- `decision`: the pull request lists it under "Decisions for you", with the files and lines.
- `test-follow-up`: an assertion is updated only after the migrated code made that test
  fail, and the test then has to pass (zod's reworded default messages).

A note found by `detect` is scored by `pack test` like a rule.

### Agent instructions

`instructions` is what the agent is told at a site no rule rewrites, after the rule's own
`guide`. They come from the sources, say what must not change (values, messages, control
flow), and never ask for a cast or a suppressed diagnostic to make the compiler pass.
Runtime never downloads instructions: they are checked in, with the date they were taken.

## Ground truth

```json
{
  "package": "zod",
  "repos": [
    {
      "repo": "owner/name",
      "commit": "<full SHA of the commit before the upgrade>",
      "migration": "https://github.com/owner/name/commit/<the upgrade commit>",
      "directory": "web",
      "from": "3.25.76",
      "to": "4.6.5",
      "with": { "@scope/companion": "2.0.1" },
      "why": "what this repository exercises",
      "findings": [{ "file": "src/schema.ts", "line": 12, "rule": "error-params" }]
    }
  ]
}
```

Each entry is a public repository at the commit **before** it made the upgrade, and the
findings the pack must report there: repository-relative file, 1-based line, and the rule
or note id. `from` is the version the lockfile has at that commit, and `to` the version the
repository upgraded to.

Where the expected findings come from: two sources that are not Uptide.

1. **The compiler.** The repository's own TypeScript, run on every `tsconfig.json`, with the
   target version linked where the package is installed and without it. Every diagnostic
   new at the target is a site: errors, and deprecations (6385, 6387, what an editor strikes
   through). A repository on TypeScript 7, which has no JavaScript API, is compiled with the
   TypeScript of this checkout, and the draft says so. The target is linked with its own
   dependencies at the versions it declares, as an install would leave it, and
   `--also <package>@<version>` links the companions the upgrade commit moved with it (the
   versions in its lockfile): `ai` 7 next to `@ai-sdk/react` 3 is a mix no repository ships,
   and its errors are not the upgrade's.
2. **The upgrade commit.** The lines it changed or removed (`git diff -U0 <commit> <upgrade>`,
   the old side). One site per change: consecutive changed lines of the same change are one
   site, at the first line of code (a line that is plainly another rule's starts a new
   one); a run with a diagnostic inside it, or right after a diagnostic of the same rule, is
   that diagnostic's site. Comment-only lines, pure insertions (no line at `<commit>`), and
   changes for another package are not sites.

`pnpm packs:truth` drafts both for one repository:

```sh
pnpm packs:truth zod owner/name <commit> <upgrade-commit> --to 4.6.5 [--directory web]
pnpm packs:truth ai vercel/chatbot <commit> <upgrade-commit> --to 7.0.9 \
  --also @ai-sdk/react@4.0.10 --also @ai-sdk/provider@4.0.1
```

It prints the compiler's new diagnostics with each line's text, and the changed and inserted
lines. You read each one, drop what is not about the package, and give every kept site its
rule, from its code and text. A site the pack has no rule for is expected under `generic`.
The expected findings never come from Uptide's output: a site `check` reports that neither
source has is a false positive, and it stays one.

`directory` is the project inside the repository when it is not at the root; `from` is the
version its lockfile has at `commit`, and `pack test` says so when it is not.

`with` lists the packages the repository's own upgrade moved together with this one, at the
versions it chose (from its `package.json` at the upgrade commit). `pack test` prints what
`check` moves with the package there and fails when it would leave one of them behind, or
cannot move one consistently: a pack whose `fix` produces an install the real upgrade never
had is not verified. Versions may differ (check picks the release that agrees with `to`);
the names may not.

`fixture` entries (`"fixture": "fixtures/repos/storefront"`) are repositories in this tree.
They are scored like the others and never count toward `verified`.

`uptide pack test` fetches each repository once: a shallow fetch of the pinned commit only,
dependencies installed from its lockfile (npm, pnpm, Yarn or bun) with lifecycle scripts
off, and nothing from the repository is ever
executed. They are kept in `~/.cache/uptide/ground-truth` (`UPTIDE_GROUND_TRUTH_CACHE`), so
`pack test --offline` runs without network after the first time. `pnpm packs:fetch` fills
the cache for every pack (and `--corpus` for the repositories in `fixtures/corpus.json`).

## Scoring: `uptide pack test`

```sh
pnpm uptide pack test zod            # from source: no build needed
uptide pack test --json              # every pack, for CI
uptide pack test zod --fixtures-only # no repository
uptide pack test zod --write         # record the result in verification.json
```

For each ground-truth repository it runs `check` with the pack (the same code path users
get), takes the sites of the plan for the package, and compares them with the expected
findings:

- **per rule**: a site counts for a rule when file, line and rule all match;
- **overall**: at the line level, every severity;
- **breaking**: at the line level, breaking findings only.

It prints precision and recall for each, and every false positive and false negative as
`repo  file:line  rule`, and sites found under another rule. It exits non-zero on any false
positive among breaking findings, any fixture failure, or a `verification.json` that no
longer matches what it measured (`--write` records it).

## Verified or candidate

A pack is **verified** only with ground truth from at least two public repositories and no
false positive among its breaking findings there (precision 100%), with at least one
breaking finding predicted. Anything else is a **candidate**:

- it ships in the tree, and `pack test` scores it;
- `check`, `list` and `fix` treat the dependency as generic: no `verified` label, the
  generic tier's evidence rule, the agent alone in `fix`.

The CLI reads the status from `verification.json`, which `pack test --write` writes and
which records the digest of the ground-truth file it was measured against. CI runs
`pack test` for every pack on every pull request that touches packs and fails when the
record no longer matches the evidence, so the label cannot outlive what supports it.

## The registry, the queue, CI

- `packages/core/src/packs/registry.ts` is generated: `pack new` renders it again with the
  new entry. Every pack in it is scored by CI; only verified ones are used by the CLI.
- `packs/queue.json` ranks the next packages worth a pack (`pnpm packs:queue`) by direct use
  × log2(1 + breaking changes). Direct use is how many sample repositories
  (`fixtures/corpus.json` and the pinned public applications in
  `scripts/packs-queue-sample.ts`) declare the package in a package.json. Breaking changes are
  the distinct ones in the diff `check` runs between the major most of them are behind on and
  the latest: a change repeated across many exports counts once, each removed or renamed
  export once. Where the official migration guide lists more breaking changes than the types
  show (CSS, configuration, runtime behavior), the guide's count is used and the entry says
  "type diff understates"; each guide's link, counted sections and items are recorded in the
  script. Weekly downloads break ties. Packages that upgrade together are one entry named
  after their hub. Out: fewer than three sample repositories using it or behind on it, fewer
  than 10 breaking changes, an official codemod that covers the whole upgrade, and the packs
  that exist. A package no diff measures enters only when its guide lists API changes,
  marked "not measured". A partial codemod is named and counts 0.9.
- The **Packs** workflow (`.github/workflows/packs.yml`) runs `uptide pack test --json` for
  every pack with the ground-truth cache restored, on pull requests that touch packs.

## The `uptide pack` command

Packs are written in an uptide checkout; the steps are in
[CONTRIBUTING.md, "Write a pack"](../CONTRIBUTING.md#write-a-pack). `pnpm uptide` runs the
CLI from source.

```sh
pnpm uptide pack new ai --from ">=6 <7" --to ">=7 <8" --maintainer @you
pnpm uptide pack test ai                 # fixtures, then check on each ground-truth repository
pnpm uptide pack test --json             # every pack, for CI
pnpm uptide pack test ai --offline       # cached repositories only
pnpm uptide pack test ai --fixtures-only
pnpm uptide pack test ai --write         # record the measured status in verification.json
pnpm uptide pack test ai --fixtures-only --update-fixtures  # write after.ts from the rules
```

`pack test` prints precision and recall per rule, overall and for breaking findings, and
every false positive and false negative as `repository  file:line  rule`. Exit codes: **0**
every pack passed, **1** a false positive among breaking findings, a failing fixture, or a
`verification.json` the run does not support, **2** it could not run (not in a checkout, bad
arguments).

The "Verified packs" table in the README is generated from each pack's `verification.json`
and ground truth by `pnpm docs:packs`; CI fails when it is stale.
