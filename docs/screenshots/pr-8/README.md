# List and check report previews

Synthetic inputs only: `fixtures/repos/nest-discovery` and the recorded storefront check fixture.

Regenerate the HTML with `pnpm exec tsx scripts/render-report-previews.ts /tmp/uptide-report-preview`.
Capture full-page screenshots at 1440 × 1100 (light and dark system color schemes) and
390 × 844 (mobile, light), at device scale 1. No external fonts or network requests are used.
The previews display the source checkout's CLI package version, currently 0.1.0. The
installed-package regression test verifies that a post-build prerelease version appears
in both `--version` and the generated report.

| Report | Light | Dark | Mobile |
| --- | --- | --- | --- |
| NestJS list | [Light](list-light.png) | [Dark](list-dark.png) | [Mobile](list-mobile.png) |
| Storefront check | [Light](check-light.png) | [Dark](check-dark.png) | [Mobile](check-mobile.png) |

[Expanded tooling](list-tooling.png) shows the lead-package group title and compact row copy actions.
