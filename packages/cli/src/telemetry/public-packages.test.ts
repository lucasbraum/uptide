import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cachedPublicVersion } from './public-packages.js';

it('only accepts exact public anonymous registry evidence, including scoped public npm names', () => {
  const cache = mkdtempSync(join(tmpdir(), 'uptide-public-evidence-'));
  const accepts = cachedPublicVersion({ UPTIDE_CACHE_DIR: cache });
  const write = (name: string, proof?: boolean) => {
    const dir = join(cache, 'registry', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'resolve-latest.json'),
      JSON.stringify({ value: { name, version: '1.0.0', publicRegistry: proof } }),
    );
  };
  write('zod', true);
  write('@public/synthetic', true);
  write('@private/synthetic', false);
  write('legacy-cache');
  expect(accepts('zod', '1.0.0')).toBe(true);
  expect(accepts('@public/synthetic', '1.0.0')).toBe(true);
  expect(accepts('zod', '2.0.0')).toBe(false);
  expect(accepts('@private/synthetic', '1.0.0')).toBe(false);
  expect(accepts('legacy-cache', '1.0.0')).toBe(false);
  expect(accepts('never-queried', '1.0.0')).toBe(false);
  expect(accepts('../../private', '1.0.0')).toBe(false);
});
