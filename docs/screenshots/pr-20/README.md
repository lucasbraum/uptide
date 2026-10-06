# List priorities and filters

Synthetic inputs only: `fixtures/repos/list-accuracy/priorities` (public packages at versions
with known advisories, with the registry and advisory responses recorded once in the fixture)
and `fixtures/repos/nest-discovery`. Nothing here comes from a real project.

Regenerate the HTML (and the terminal text, `list-priorities.txt`) with
`pnpm exec tsx scripts/render-report-previews.ts /tmp/uptide-report-preview`, then capture at
1440 × 1100 (light) and 375 × 812 (mobile).

| View | Screenshot |
| --- | --- |
| Priorities: runtime before dev, same-major fixes first, each command at its smallest fix | [list-priorities.png](list-priorities.png) |
| Nest report opened from `#filter=tooling`: the collapsed Tooling section opens with its 19 rows | [list-filter-tooling.png](list-filter-tooling.png) |
| Mobile, opened from `#filter=priority` | [list-priorities-mobile.png](list-priorities-mobile.png) |
