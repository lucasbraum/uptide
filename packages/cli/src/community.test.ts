import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

describe('open source files', () => {
  it('is MIT everywhere a license is stated', () => {
    expect(read('LICENSE')).toMatch(/^MIT License\n/);
    for (const manifest of [
      'package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ])
      expect(JSON.parse(read(manifest)).license, manifest).toBe('MIT');
    expect(read('README.md')).toContain('[MIT](LICENSE)');
    expect(read('CONTRIBUTING.md')).toContain('[MIT license](LICENSE)');
  });

  it('tells a contributor how to set up, test, and what a pack is', () => {
    const contributing = read('CONTRIBUTING.md');
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    // Every `pnpm <script>` the guide names exists.
    for (const [, script] of contributing.matchAll(/(?:^|`|&& )pnpm ([a-z][a-z:]+)/gm)) {
      if (script === 'install') continue;
      expect(scripts, `pnpm ${script}`).toHaveProperty(script as string);
    }
    for (const path of contributing.matchAll(/`((?:packages|docs|fixtures)\/[^`<* ]+)`/g))
      expect(existsSync(new URL(path[1] as string, root)), path[1]).toBe(true);
    for (const heading of ['## Setup', '## How packs work', '## Pull requests'])
      expect(contributing).toContain(heading);
  });

  it('states the isolation model and a private way to report', () => {
    const security = read('SECURITY.md');
    expect(security).toContain('## Isolation model');
    expect(security).toContain('temporary clone');
    expect(security).toContain('lifecycle scripts disabled');
    expect(security).toContain('--no-llm');
    expect(security).toContain('## Reporting a vulnerability');
    expect(security).toContain('do not open a public issue');
  });

  it('has a code of conduct, issue forms and a pull request template', () => {
    expect(read('CODE_OF_CONDUCT.md')).toContain('Contributor Covenant');
    const forms = readdirSync(new URL('.github/ISSUE_TEMPLATE/', root));
    expect(forms.sort()).toEqual(['bug.yml', 'config.yml', 'pack-request.yml']);
    for (const form of ['bug.yml', 'pack-request.yml']) {
      const text = read(`.github/ISSUE_TEMPLATE/${form}`);
      for (const key of ['name:', 'description:', 'body:']) expect(text, form).toContain(key);
    }
    expect(read('.github/PULL_REQUEST_TEMPLATE.md')).toContain('## Checklist');
  });
});
