import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { fakeEngine, memoryIo } from './test-utils.js';

const root = new URL('../../../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');

describe('README', () => {
  it('opens with the pitch and a quickstart that needs no setup', () => {
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
    // Renovate and Dependabot are tools Uptide works alongside, named once, never the framing.
    expect(readme.match(/Renovate/g)).toHaveLength(1);
    expect(readme).not.toContain('Renovate updates');
    const quickstart = readme.slice(
      readme.indexOf('## Quickstart'),
      readme.indexOf('## Before and after'),
    );
    for (const command of ['npx uptide ', 'npx uptide check', 'npx uptide fix --only zod'])
      expect(quickstart).toContain(command);
    expect(quickstart).toContain('No account, no config.');
  });

  it('shows a before and after from a fixture in this repository', () => {
    const example = readme.slice(
      readme.indexOf('## Before and after'),
      readme.indexOf('## What is supported'),
    );
    const fixture = /\]\((fixtures\/repos\/[a-z-]+)\)/.exec(example)?.[1];
    expect(fixture && existsSync(new URL(fixture, root))).toBe(true);
    expect(example).toContain('uptide check · storefront');
    expect(example).toContain('uptide fix · zod 3.25.76 → 4.6.5');
    expect(example).toContain('uptide fix · stripe 14.25.0 → 23.0.0');
    // What a stable build prints, and what the quickstart says.
    expect(readme).not.toContain('uptide@next');
    expect(example.match(/```diff\n-.*\n\+.*\n```/g)).toHaveLength(2);
  });

  it('features no other project: it links no repository on GitHub', () => {
    expect([...readme.matchAll(/github\.com\/[\w.-]+\/[\w.-]+/g)].map((m) => m[0])).toEqual([]);
  });

  it('explains the support tiers, verification, privacy and exit codes', () => {
    expect(readme).toMatch(/\| \*\*Verified\*\* \| zod 3 → 4, stripe 14 and newer \|/);
    expect(readme).toMatch(/\| \*\*Generic\*\* \| any other dependency/);
    for (const heading of ['## How verification works', '## Privacy', '## Documentation'])
      expect(readme).toContain(heading);
    const privacy = readme.slice(readme.indexOf('## Privacy'), readme.indexOf('## Exit codes'));
    for (const fact of ['ANTHROPIC_API_KEY', '--no-llm', 'No telemetry', 'No LLM call'])
      expect(privacy).toContain(fact);
    expect(readme).toMatch(
      /\*\*0\*\* nothing breaking, \*\*1\*\* breaking changes found,\n\*\*2\*\*/,
    );
    expect(readme).toContain('[MIT](LICENSE)');
  });

  it('links only files that exist', () => {
    for (const [, target] of readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g))
      expect(existsSync(new URL(target as string, root)), target).toBe(true);
  });

  it('documents only flags the CLI accepts', async () => {
    const help: string[] = [];
    for (const command of ['check', 'fix', 'pr', 'verify', 'clean']) {
      const io = memoryIo();
      await run([command, '--help'], io, fakeEngine());
      help.push(io.stdout());
    }
    const flags = new Set(readme.match(/--[a-z][a-z-]+/g));
    // `git diff --stat` is git's flag, printed in fix's real output.
    flags.delete('--stat');
    for (const flag of flags) expect(help.join('\n'), flag).toContain(flag);
  });
});
