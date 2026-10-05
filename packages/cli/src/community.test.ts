import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** Every package in the workspace, so a new one cannot quietly state another license. */
const workspaceManifests = (): string[] =>
  readdirSync(new URL('packages/', root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
    .sort();

describe('open source files', () => {
  it('is Apache-2.0 everywhere a license is stated', () => {
    // The license text as apache.org publishes it, unmodified.
    const license = read('LICENSE');
    expect(
      license
        .split('\n')
        .slice(0, 3)
        .map((line) => line.trim()),
    ).toEqual(['', 'Apache License', 'Version 2.0, January 2004']);
    expect(license).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    expect(license).toContain('APPENDIX: How to apply the Apache License to your work.');
    expect(license).not.toContain('MIT');
    // Every manifest in the workspace, published or not.
    for (const manifest of ['package.json', ...workspaceManifests()])
      expect(JSON.parse(read(manifest)).license, manifest).toBe('Apache-2.0');
    expect(read('README.md')).toContain('[Apache-2.0](LICENSE)');
    expect(read('CONTRIBUTING.md')).toContain('[Apache License, Version 2.0](LICENSE)');
    // Already published, so still MIT: the change applies from the next minor on.
    expect(read('README.md')).toContain('up to and including 0.3.0 were published under the MIT');
  });

  it('has a NOTICE naming the project, and pointing at the bundled notices', () => {
    const notice = read('NOTICE');
    expect(notice.split('\n').slice(0, 2)).toEqual([
      'Uptide',
      'Copyright 2026 Lucas Braum and the Uptide contributors',
    ]);
    expect(notice).toContain('THIRD-PARTY-NOTICES');
  });

  it('asks for a DCO sign-off and checks every commit for it', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const fact of [
      'Developer Certificate of Origin',
      'git commit -s',
      'Signed-off-by:',
      'git rebase --signoff',
      'Every commit in a pull request needs the line',
    ])
      expect(contributing, fact).toContain(fact);
    const workflow = read('.github/workflows/dco.yml');
    expect(workflow).toContain('scripts/dco.mjs');
    // Read-only, and on the pull request event: the check never holds a write token.
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('pull_request_target');
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
