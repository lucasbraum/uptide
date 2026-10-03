import { describe, expect, it } from 'vitest';
import { describeRepo, detectRepo, findLockfile } from './detect.js';
import { tempRepo } from './test-utils.js';

describe('which lockfile a repository means', () => {
  it('follows packageManager when several are present, else precedence, and names the rest', async () => {
    const root = tempRepo({
      'package.json': '{"name":"app","packageManager":"yarn@1.22.22"}',
      'yarn.lock': '# yarn lockfile v1\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    const lock = findLockfile(root);
    expect(lock?.manager).toBe('yarn');
    expect(lock?.chosen).toBe(
      'yarn.lock (packageManager says yarn); pnpm-lock.yaml left untouched',
    );
    const repo = await detectRepo(root, async () => ['.']);
    expect(describeRepo(repo)).toBe(
      'app (yarn) · yarn.lock (packageManager says yarn); pnpm-lock.yaml left untouched',
    );
    const silent = tempRepo({
      'package.json': '{"name":"app"}',
      'yarn.lock': '# yarn lockfile v1\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    expect(findLockfile(silent)).toMatchObject({
      manager: 'pnpm',
      chosen:
        'pnpm-lock.yaml (first by precedence: pnpm, npm, yarn, bun); yarn.lock left untouched',
    });
    const one = tempRepo({ 'package.json': '{"name":"app"}', 'yarn.lock': '# yarn lockfile v1\n' });
    expect(findLockfile(one)?.chosen).toBeUndefined();
  });
});
