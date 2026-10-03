import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirtyLines, uptideCommand, uptideVersionInfo, version } from './version.js';

it('uses the real private engine manifest version in reports', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.private).toBe(true);
  expect(version).toBe(pkg.version);
  expect(version).not.toBe('0.0.0');
  expect(uptideVersionInfo().uptideVersion).toBe(version);
});
it('resolves the public worker entry without a private source or dist path', () => {
  expect(import.meta.resolve('@uptide/core/worker')).toBe(
    new URL('../dist/worker.js', import.meta.url).href,
  );
});
it('does not call a tree dirty for the scratch config the bundler writes while building', () => {
  expect(dirtyLines('')).toEqual([]);
  expect(dirtyLines('?? packages/core/tsup.config.bundled_ab12cd34ef.mjs\n')).toEqual([]);
  expect(dirtyLines('?? tsup.config.bundled_x1.mjs\n M packages/core/src/version.ts\n')).toEqual([
    ' M packages/core/src/version.ts',
  ]);
  // Anything else, a real config edit included, is a dirty tree.
  expect(dirtyLines(' M packages/core/tsup.config.ts\n?? notes.txt\n')).toHaveLength(2);
});

describe('uptideCommand', () => {
  it('names the dist-tag the running build was published under', () => {
    expect(uptideCommand('0.3.0')).toBe('npx uptide');
    expect(uptideCommand('0.2.0-next.20261003172442')).toBe('npx uptide@next');
    expect(uptideCommand('1.0.0-beta.2')).toBe('npx uptide@beta');
  });
});
