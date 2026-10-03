import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLockScope } from './lock-guard.js';
import { pnpmGraph, yarnGraph } from './text-lock.js';

it('permits target catalog changes while protecting other catalog entries', () => {
  const lock = (target: string, other = '1.0.0') => `lockfileVersion: '9.0'
catalogs:
  default:
    target:
      specifier: ^${target}
      version: ${target}
    other:
      specifier: ${other}
      version: ${other}
importers:
  .: {}
packages:
  target@${target}: {}
snapshots:
  target@${target}: {}
`;
  const before = pnpmGraph(lock('1.0.0'), 'target');
  expect(() => assertLockScope(before, pnpmGraph(lock('2.0.0'), 'target'), 'target')).not.toThrow();
  expect(() =>
    assertLockScope(before, pnpmGraph(lock('2.0.0', '2.0.0'), 'target'), 'target'),
  ).toThrow('outside target');
});

describe('alias entries (@isaacs/cliui style) survive a manager re-quoting them', () => {
  const dir = resolve(import.meta.dirname, '../../../../../fixtures/lockfiles/aliases');
  const bump = (text: string): string =>
    text
      .replaceAll('3.25.76', '4.6.5')
      .replace('zod@^3.22.4', 'zod@^4.6.5')
      .replace('specifier: ^3.22.4', 'specifier: ^4.6.5');

  it('yarn v1: the same entries quoted and ordered differently are the same entries', () => {
    const before = readFileSync(join(dir, 'yarn.lock'), 'utf8');
    // What yarn wrote back: quotes moved, descriptors reordered, nothing resolved differently.
    const after = bump(before)
      .replace(
        '"string-width-cjs@npm:string-width@^4.2.0", string-width@^4.1.0, string-width@^4.2.0:',
        'string-width@^4.1.0, string-width@^4.2.0, "string-width-cjs@npm:string-width@^4.2.0":',
      )
      .replace(
        '"strip-ansi-cjs@npm:strip-ansi@^6.0.1", strip-ansi@^6.0.0, strip-ansi@^6.0.1:',
        '"strip-ansi@^6.0.0", "strip-ansi@^6.0.1", "strip-ansi-cjs@npm:strip-ansi@^6.0.1":',
      )
      .replace(
        '"wrap-ansi-cjs@npm:wrap-ansi@^7.0.0", wrap-ansi@^7.0.0:',
        'wrap-ansi@^7.0.0, "wrap-ansi-cjs@npm:wrap-ansi@^7.0.0":',
      )
      .replace('    string-width "^4.1.0"', '    "string-width" "^4.1.0"');
    const diff = assertLockScope(yarnGraph(before, 'zod'), yarnGraph(after, 'zod'), 'zod');
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual(['zod@^4.6.5']);
    expect(diff.removed).toEqual(['zod@^3.22.4']);
    // A real resolution change under an alias is still caught, with versions.
    const real = after.replace('version "4.2.3"', 'version "4.2.2"');
    expect(() => assertLockScope(yarnGraph(before, 'zod'), yarnGraph(real, 'zod'), 'zod')).toThrow(
      'string-width-cjs@npm:string-width@^4.2.0 (4.2.3 → 4.2.2)',
    );
    // Yarn splitting a block in two, same version and resolution on both: no change at all.
    const split = after.replace(
      'string-width@^4.1.0, string-width@^4.2.0, "string-width-cjs@npm:string-width@^4.2.0":',
      '"string-width-cjs@npm:string-width@^4.2.0":\n  version "4.2.3"\n  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz#269c7117d27b05ad2e536830a8ec895ef9c6d010"\n  integrity sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g==\n  dependencies:\n    strip-ansi "^6.0.1"\n\nstring-width@^4.1.0, string-width@^4.2.0:',
    );
    expect(
      assertLockScope(yarnGraph(before, 'zod'), yarnGraph(split, 'zod'), 'zod').changed,
    ).toEqual([]);
  });

  it('yarn berry: a quoted list of descriptors is several descriptors', () => {
    const berry = [
      '__metadata:',
      '  version: 8',
      '',
      '"call-bind-apply-helpers@npm:^1.0.1, call-bind-apply-helpers@npm:^1.0.2":',
      '  version: 1.0.2',
      '  resolution: "call-bind-apply-helpers@npm:1.0.2"',
      '  checksum: abc',
      '  languageName: node',
      '  linkType: hard',
      '',
      '"zod@npm:^3.22.4":',
      '  version: 3.25.76',
      '  resolution: "zod@npm:3.25.76"',
      '  checksum: def',
      '  languageName: node',
      '  linkType: hard',
      '',
    ].join('\n');
    const graph = yarnGraph(berry, 'zod');
    expect([...graph.records.keys()]).toEqual([
      'call-bind-apply-helpers@npm:^1.0.1',
      'call-bind-apply-helpers@npm:^1.0.2',
      'zod@npm:^3.22.4',
    ]);
    const after = berry.replaceAll('3.25.76', '4.6.5').replace('zod@npm:^3.22.4', 'zod@npm:^4.6.5');
    expect(assertLockScope(graph, yarnGraph(after, 'zod'), 'zod').changed).toEqual([]);
  });

  it('pnpm: a zod bump next to aliased snapshots passes', () => {
    const before = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
    const after = bump(before).replace(
      '      string-width-cjs: string-width@4.2.3',
      "      'string-width-cjs': string-width@4.2.3",
    );
    const diff = assertLockScope(pnpmGraph(before, 'zod'), pnpmGraph(after, 'zod'), 'zod');
    expect(diff.added).toEqual(['packages:zod@4.6.5', 'snapshots:zod@4.6.5']);
    expect(diff.removed).toEqual(['packages:zod@3.25.76', 'snapshots:zod@3.25.76']);
  });
});
