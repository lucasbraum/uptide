import { expect, it } from 'vitest';
import { resolveTarget } from './target.js';

const pack = { name: 'stripe', defaultTarget: '22.6.2' };

it('takes the requested version, else npm latest, else the pack target when offline', async () => {
  const registry = async (name: string, tag: string) => {
    expect(name).toBe('stripe');
    expect(tag).toBe('latest');
    return '23.0.0';
  };
  expect(await resolveTarget(pack, '22.5.0', registry)).toEqual({
    version: '22.5.0',
    source: 'requested',
  });
  expect(await resolveTarget(pack, 'stripe@22.5.0', registry)).toEqual({
    version: '22.5.0',
    source: 'requested',
  });
  expect(await resolveTarget(pack, undefined, registry)).toEqual({
    version: '23.0.0',
    source: 'latest on npm',
  });
  expect(await resolveTarget(pack, 'latest', registry)).toEqual({
    version: '23.0.0',
    source: 'latest on npm',
  });
  expect(
    await resolveTarget(pack, undefined, async () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    }),
  ).toEqual({ version: '22.6.2', source: "the pack's tested target" });
});
