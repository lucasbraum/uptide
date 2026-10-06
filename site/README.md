# Landing page

`index.html` is the whole site: one static page with inline CSS, a few lines of inline
JavaScript for the copy buttons, and self-hosted fonts. No build step and no external
requests.

```sh
npx serve site         # or any static file server; open http://localhost:3000
```

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page. Design tokens are the same as the list/check HTML report (`packages/cli/src/html/assets.ts`); light and dark follow the system. |
| `favicon.svg` | The logo mark, blue in light mode and light blue in dark mode. |
| `og.png` | Social preview, 1280×640. Used for `og:image` and `twitter:image`, and meant for the repository's social preview setting. |
| `og-image.html` | Source of `og.png`. Render it at 1280×640 with a headless browser and save a PNG screenshot. |
| `fonts/` | Space Grotesk, Instrument Sans and IBM Plex Mono, Latin subsets (from Fontsource 5.3.0), each under the SIL Open Font License 1.1; the license texts are next to them. |

`og:image` points at `raw.githubusercontent.com/uptide-dev/uptide/main/site/og.png`, so it
resolves once this directory is on `main`. Switch it to the site's own URL when the page
has a domain.

## Where the numbers come from

Every number on the page is printed output, never edited:

- `list` on [supabase/supabase](https://github.com/supabase/supabase) at commit
  `9d1661dec1548ec5bf3ffb4f551376a7650c213e`, run with uptide 0.4.0 on 2026-10-06 from the
  repository root (`npx uptide list`). Rows are trimmed. Latest versions and advisories come
  from the registry at run time, so a rerun prints different numbers: when you refresh the
  page, rerun and replace the block and the four tiles together, and update the footnote.
- `check` and `fix` on `fixtures/repos/storefront`: the same blocks as the README's "Before
  and after". If those numbers change, change them in both places.
- Timings in the hero note: `list` on the storefront fixture (about a second) and on the
  supabase commit above (24 seconds).
