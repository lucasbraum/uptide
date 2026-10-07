<!-- Open with ?template=pack.md. The contract is docs/packs.md; the steps are CONTRIBUTING.md, "Write a pack". -->

## Pack

<!-- Package, from → to (semver ranges), and the pack-request issue it closes. -->

## Sources

<!-- The changelog or migration guide each rule and note is taken from (also in meta.sources). -->

## Rules and behavior notes

<!-- One line each: id, what it detects, whether it rewrites or goes to the agent, how a note is reported. -->

## Ground-truth repositories

<!-- Each: repository, the pinned commit (the one before the upgrade), the upgrade commit or PR the expected findings come from, and how many findings. -->

## `uptide pack test` output

```
paste the output of: pnpm uptide pack test <package>
```

## Checklist

- [ ] Every rule and note comes from a source listed in `meta.sources`
- [ ] Every rule that rewrites or detects has a fixture case, with a site it must leave alone (`keep`)
- [ ] Ground truth: public repositories at the commit before their upgrade; expected findings read from their own upgrade commit and the compiler, never copied from Uptide's output
- [ ] At least two public repositories for `verified`; otherwise the pack ships as a candidate
- [ ] `pnpm uptide pack test <package>` passes and its output is pasted above; `verification.json` written with `--write`
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] Changeset added (`pnpm changeset`): a new pack is something users notice
- [ ] No private code, names or paths anywhere: fixtures are synthetic, ground truth is public
