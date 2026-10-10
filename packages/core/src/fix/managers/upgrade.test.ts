import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as process from '../process.js';
import { upgradeInstall } from './upgrade.js';

it('keeps simple npm aliases during exact resolution and restores partial ranges on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-alias-upgrade-'));
  const original = JSON.stringify({
    dependencies: { runtime: 'npm:react@^19', types: 'npm:@types/react@~19.3' },
  });
  writeFileSync(join(root, 'package.json'), original);
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  const command = vi.spyOn(process, 'command').mockImplementation(async (_root, _bin, args) => {
    if (args[0] === '--version') return { code: 0, output: '11.0.0', timeout: false };
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies).toEqual({
      runtime: 'npm:react@19.3.0',
      types: 'npm:@types/react@19.3.1',
    });
    throw new Error('registry unavailable');
  });
  try {
    await expect(
      upgradeInstall(root, {
        name: 'runtime',
        version: '19.3.0',
        also: [{ name: 'types', version: '19.3.1' }],
        files: ['package.json'],
        workspaces: ['.'],
      }),
    ).rejects.toThrow('registry unavailable');
    expect(command).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(original);
  } finally {
    command.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
