import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { fakeEngine, memoryIo } from './test-utils.js';

const root = new URL('../../../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const section = (from: string, to: string): string =>
  readme.slice(readme.indexOf(from), readme.indexOf(to));

describe('README', () => {
  it('opens with the pitch, the badges, one picture and a quickstart that needs no setup', () => {
    // The tagline is the first line under the title, then the one-sentence pitch npm shows.
    expect(readme.split('\n').slice(0, 3)).toEqual([
      '# Uptide',
      '',
      '**Migrations you can merge.**',
    ]);
    const pitch =
      'Uptide finds what a dependency upgrade breaks in your code, migrates it, and proves it with your compiler and tests.';
    expect(readme.replace(/\s+/g, ' ')).toContain(pitch);
    expect(
      JSON.parse(readFileSync(new URL('packages/cli/package.json', root), 'utf8')).description,
    ).toBe(pitch);
    // Three badges, under the pitch: npm version, CI, and the license linking to its text.
    const badges = readme.split('\n').filter((l) => l.startsWith('[!['));
    expect(badges).toHaveLength(3);
    expect(badges).toContain(
      '[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)',
    );
    // One picture, from the public fixtures' screenshots.
    const images = [...readme.matchAll(/^!\[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1] as string);
    expect(images).toHaveLength(1);
    expect(existsSync(new URL(images[0] as string, root))).toBe(true);
    // Renovate and Dependabot are tools Uptide works alongside, named once, never the framing.
    expect(readme.match(/Renovate/g)).toHaveLength(1);
    expect(readme).not.toContain('Renovate updates');
    const quickstart = section('## Quickstart', '## Why Uptide');
    for (const command of [
      'npx uptide list',
      'npx uptide check zod',
      'npx uptide fix zod',
      'npx uptide pr --branch',
    ])
      expect(quickstart).toContain(command);
    expect(quickstart).toContain('No account, no config.');
    expect(quickstart).toContain('Node 20 or newer');
  });

  it('stays short: under 150 lines, the generated packs table not counted', () => {
    // The table between the markers grows one row per pack (`pnpm docs:packs`); the prose does not.
    const prose = readme.replace(/<!-- packs:start -->[\s\S]*?<!-- packs:end -->/, '');
    expect(prose.split('\n').length).toBeLessThanOrEqual(150);
  });

  it('shows a before and after from a fixture in this repository', () => {
    const example = section('## Before and after', '## Privacy');
    const fixture = /\]\((fixtures\/repos\/[a-z-]+)\)/.exec(example)?.[1];
    expect(fixture && existsSync(new URL(fixture, root))).toBe(true);
    expect(example).toContain('uptide check · storefront');
    expect(example).toContain('uptide fix · zod 3.25.76 → 4.6.5');
    // What a stable build prints, and what the quickstart says.
    expect(readme).not.toContain('uptide@next');
    expect(example.match(/```diff\n-.*\n\+.*\n```/g)).toHaveLength(1);
  });

  it('features no other project: the only repository it links on GitHub is its own', () => {
    expect([
      ...new Set([...readme.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)].map((m) => m[1])),
    ]).toEqual(['uptide-dev/uptide']);
  });

  it('lists the verified packs from a generated table, and privacy in four lines plus the table', () => {
    const packs = section('<!-- packs:start -->', '<!-- packs:end -->');
    expect(packs).toContain(
      '| Package | Range | Precision | Recall | Ground-truth repositories | Status |',
    );
    for (const name of ['`zod`', '`stripe`', '`ai`']) expect(packs).toContain(`| ${name} |`);
    const privacy = section('## Privacy', '## Documentation');
    const prose = privacy
      .split('\n')
      .filter(
        (l) => l !== '' && !l.startsWith('|') && !l.startsWith('#') && !l.startsWith('The full'),
      );
    expect(prose).toHaveLength(4);
    for (const fact of ['--no-llm', 'off by default', 'No LLM call', 'no Uptide server'])
      expect(privacy).toContain(fact);
    expect(readme).toContain('[Apache-2.0](LICENSE)');
    expect(readme).toContain('Releases up to and including 0.3.0 were published under the MIT');
  });

  it('links only files that exist', () => {
    for (const [, target] of readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g))
      expect(existsSync(new URL(target as string, root)), target).toBe(true);
  });

  it('documents only flags the CLI accepts', async () => {
    const help: string[] = [];
    for (const command of ['check', 'plan', 'fix', 'pr', 'verify', 'clean']) {
      const io = memoryIo();
      await run([command, '--help'], io, fakeEngine());
      help.push(io.stdout());
    }
    const flags = new Set(readme.match(/--[a-z][a-z-]+/g));
    for (const flag of flags) expect(help.join('\n'), flag).toContain(flag);
  });
});
