// biome-ignore-all lint/suspicious/noTemplateCurlyInString: a shell command quoted as written in the workflow.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const site = `${root}site/`;
const page = readFileSync(`${site}index.html`, 'utf8');

describe('the landing page (site/)', () => {
  it('ships every font next to its license', () => {
    const files = readdirSync(`${site}fonts`);
    const fonts = files.filter((f) => f.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const license = `LICENSE-${font.replace(/-latin-.*$/, '')}.txt`;
      expect(files, font).toContain(license);
      expect(readFileSync(`${site}fonts/${license}`, 'utf8')).toContain(
        'SIL Open Font License, Version 1.1',
      );
    }
  });

  it('takes its own address from the one SITE_URL the Pages workflow writes in', () => {
    for (const tag of [
      '<link rel="canonical" href="%SITE_URL%">',
      '<meta property="og:url" content="%SITE_URL%">',
      '<meta property="og:image" content="%SITE_URL%og.png">',
      '<meta name="twitter:image" content="%SITE_URL%og.png">',
    ])
      expect(page).toContain(tag);
    expect(page).not.toMatch(/uptide-dev\.github\.io|raw\.githubusercontent/);
    const workflow = parse(readFileSync(`${root}.github/workflows/pages.yml`, 'utf8'));
    const deploy = workflow.jobs.deploy;
    expect(deploy.env.SITE_URL).toBe('https://uptide-dev.github.io/uptide/');
    expect(deploy.steps.map((s: { run?: string }) => s.run ?? '').join('\n')).toContain(
      'sed -i "s#%SITE_URL%#${SITE_URL}#g" site/index.html',
    );
  });

  it('loads nothing from another origin', () => {
    // Links to other sites are fine; fonts, styles, scripts and images are all local.
    const loads = [...page.matchAll(/(?:src|href)=["']?([^"'\s>]+)/g)]
      .map((m) => m[1] as string)
      .filter((url) => /^(https?:)?\/\//.test(url));
    const tags = [...page.matchAll(/<(link|script|img|source)\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of tags) expect(tag, tag).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(page).not.toMatch(/url\((["']?)(https?:)?\/\//);
    expect(loads.length).toBeGreaterThan(0); // the outbound links themselves
  });

  it('deploys on a push to main that changes site/, with Pages permissions only', () => {
    const workflow = parse(readFileSync(`${root}.github/workflows/pages.yml`, 'utf8'));
    expect(workflow.on.push).toEqual({
      branches: ['main'],
      paths: ['site/**', '.github/workflows/pages.yml'],
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.deploy.permissions).toEqual({
      contents: 'read',
      pages: 'write',
      'id-token': 'write',
    });
    const uses = workflow.jobs.deploy.steps.map((s: { uses?: string }) => s.uses ?? '');
    expect(uses).toContain('actions/upload-pages-artifact@v3');
    expect(uses).toContain('actions/deploy-pages@v4');
  });
});
