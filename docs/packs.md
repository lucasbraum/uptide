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
  path it matches (`kinds`, `symbols`). For sites no type diff reports, a rule can add
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

Each marked site of a rule with `rewrite` is rewritten, bottom-up, and the result must equal
`after.ts` byte for byte (the markers are comments, so they stay). A rule or note with
`detect` must find exactly the marked lines in `before.ts`, and nothing on any other line.
Fixtures are test data: biome and `tsc` skip them, and they are never reformatted.

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
      "from": "3.25.76",
      "to": "4.1.12",
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

Where the expected findings come from:

1. the sites the repository's own upgrade commit changed for this dependency (`git diff
   <commit> <upgrade> -U0`, the old side's line numbers), and
2. the errors the compiler reports at the target that the upgrade commit fixed,

each read and kept only when it is about this dependency. A site that `check` reports and
that nobody had to change is a false positive, and it stays one: the expected findings
never come from Uptide's own output. A site the pack has no rule for is expected under
`generic`, which is what `pack test` calls a site the plan groups under no rule of the pack.

`fixture` entries (`"fixture": "fixtures/repos/storefront"`) are repositories in this tree.
They are scored like the others and never count toward `verified`.

`uptide pack test` fetches each repository once: a shallow fetch of the pinned commit only,
dependencies installed with lifecycle scripts off, and nothing from the repository is ever
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
- `packs/queue.json` ranks the next packages worth a pack from public npm data
  (`pnpm packs:queue`): weekly downloads times breaking majors in the last two years.
- The **Packs** workflow (`.github/workflows/packs.yml`) runs `uptide pack test --json` for
  every pack with the ground-truth cache restored, on pull requests that touch packs.
