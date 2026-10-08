import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInstalled } from './repo.js';

describe('readInstalled', () => {
  it('records a workspace dependency under its declared specifier, whatever the lockfile wrote for it', () => {
    // Yarn Berry records a workspace package as `0.0.0-use.local`, which nothing downstream
    // recognises as a link; the declared `workspace:*` is what says it is one.
    const root = mkdtempSync(join(tmpdir(), 'uptide-ws-lock-'));
    const app = join(root, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@acme/app',
        dependencies: { '@acme/ui': 'workspace:*', react: '^18.3.1' },
      }),
    );
    writeFileSync(
      join(root, 'yarn.lock'),
      [
        '"@acme/ui@workspace:*, @acme/ui@workspace:packages/ui":',
        '  version: 0.0.0-use.local',
        '  resolution: "@acme/ui@workspace:packages/ui"',
        '',
        '"react@npm:^18.3.1":',
        '  version: 18.3.1',
        '',
      ].join('\n'),
    );
    const { installed } = readInstalled(app);
    expect(installed.get('@acme/ui')).toBe('workspace:*');
    expect(installed.get('react')).toBe('18.3.1');
  });
});
