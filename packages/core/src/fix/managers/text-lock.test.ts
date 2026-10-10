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

it('lets a package and its companions move together, and nothing else', () => {
  const lock = (
    ai: string,
    react: string,
    provider: string,
    other = '1.0.0',
  ) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      ai:
        specifier: ${ai}
        version: ${ai}
      '@ai-sdk/react':
        specifier: ${react}
        version: ${react}(ai@${ai})
      other:
        specifier: ${other}
        version: ${other}
packages:
  ai@${ai}: {}
  '@ai-sdk/react@${react}': {}
  '@ai-sdk/provider@${provider}': {}
  other@${other}: {}
snapshots:
  ai@${ai}:
    dependencies:
      '@ai-sdk/provider': ${provider}
  '@ai-sdk/react@${react}(ai@${ai})':
    dependencies:
      ai: ${ai}
  '@ai-sdk/provider@${provider}': {}
  other@${other}: {}
`;
  const names = ['ai', '@ai-sdk/react'];
  const before = pnpmGraph(lock('6.0.116', '3.0.118', '3.0.3'), names);
  expect(() =>
    assertLockScope(before, pnpmGraph(lock('7.0.9', '4.0.10', '4.0.1'), names), names),
  ).not.toThrow();
  // ai alone may not drag @ai-sdk/react to its next major: that is what the group is for.
  expect(() =>
    assertLockScope(
      pnpmGraph(lock('6.0.116', '3.0.118', '3.0.3'), 'ai'),
      pnpmGraph(lock('7.0.9', '4.0.10', '4.0.1'), 'ai'),
      'ai',
    ),
  ).toThrow('outside ai');
  expect(() =>
    assertLockScope(before, pnpmGraph(lock('7.0.9', '4.0.10', '4.0.1', '2.0.0'), names), names),
  ).toThrow('outside ai, @ai-sdk/react');
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

  it('pnpm: dependents renamed after the target as their peer are the same entries', () => {
    const lock = (core: string): string =>
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@art/collection':",
        '        specifier: ^9.4.3',
        `        version: 9.4.3(@art/core@${core})`,
        "      '@art/core':",
        `        specifier: ^${core}`,
        `        version: ${core}`,
        'packages:',
        "  '@art/collection@9.4.3':",
        '    resolution: {integrity: sha512-collection}',
        `  '@art/core@${core}':`,
        `    resolution: {integrity: sha512-core-${core}}`,
        'snapshots:',
        `  '@art/collection@9.4.3(@art/core@${core})':`,
        '    dependencies:',
        `      '@art/core': ${core}`,
        `  '@art/core@${core}': {}`,
        '',
      ].join('\n');
    const diff = assertLockScope(
      pnpmGraph(lock('9.4.3'), '@art/core'),
      pnpmGraph(lock('10.7.0'), '@art/core'),
      '@art/core',
    );
    // Only the target itself moved; its dependent kept its entry under a new name.
    expect(diff.added).toEqual(['packages:@art/core@10.7.0', 'snapshots:@art/core@10.7.0']);
    expect(diff.removed).toEqual(['packages:@art/core@9.4.3', 'snapshots:@art/core@9.4.3']);
    // A dependent that really changed is still caught.
    const tampered = lock('10.7.0').replace('sha512-collection', 'sha512-other');
    expect(() =>
      assertLockScope(
        pnpmGraph(lock('9.4.3'), '@art/core'),
        pnpmGraph(tampered, '@art/core'),
        '@art/core',
      ),
    ).toThrow('outside @art/core');
  });
});

it.each(['pnpm', 'yarn'] as const)(
  '%s accepts only metadata housekeeping and equivalent dependency descriptors',
  (manager) => {
    const text =
      manager === 'pnpm'
        ? `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  parent@1.0.0:
    resolution: {integrity: sha512-parent}
    license: null
  child@1.0.0:
    resolution: {integrity: sha512-child}
snapshots:
  parent@1.0.0:
    dependencies:
      child: 1.0.0
  child@1.0.0: {}
`
        : `parent@^1:
  version "1.0.0"
  integrity sha512-parent
  license null
  dependencies:
    child "^1"
child@^1, child@~1:
  version "1.0.0"
  integrity sha512-child
`;
    const graph = manager === 'pnpm' ? pnpmGraph : yarnGraph;
    const before = graph(text, 'target');
    expect(
      assertLockScope(
        before,
        graph(
          text.replace('license: null', 'license: MIT').replace('license null', 'license MIT'),
          'target',
        ),
        'target',
      ).housekeeping?.metadata.length,
    ).toBe(1);
    for (const next of [
      text.replace('sha512-child', 'tampered'),
      text.replace('license', 'scripts'),
      text
        .replaceAll('child@1.0.0', 'child@2.0.0')
        .replace('child: 1.0.0', 'child: 2.0.0')
        .replace(
          'version "1.0.0"\n  integrity sha512-child',
          'version "2.0.0"\n  integrity sha512-child',
        ),
    ]) {
      expect(() => assertLockScope(before, graph(next, 'target'), 'target')).toThrow(
        'outside target',
      );
    }
    if (manager === 'yarn') {
      const regrouped = text
        .replace('child "^1"', 'child "~1"')
        .replace('child@^1, child@~1:', 'child@~1:');
      expect(
        assertLockScope(before, graph(regrouped, 'target'), 'target').housekeeping?.deduped,
      ).toMatchObject([{ from: 'child@^1', to: 'child@~1' }]);
    }
  },
);

it('protects resolutions in older pnpm inline-package graphs too', () => {
  const before = `lockfileVersion: '6.0'
importers:
  .: {}
packages:
  /parent@1.0.0:
    resolution: {integrity: sha512-parent}
    dependencies:
      child: 1.0.0
  /child@1.0.0:
    resolution: {integrity: sha512-child1}
  /child@2.0.0:
    resolution: {integrity: sha512-child2}
`;
  expect(() =>
    assertLockScope(
      pnpmGraph(before, 'target'),
      pnpmGraph(before.replace('child: 1.0.0', 'child: 2.0.0'), 'target'),
      'target',
    ),
  ).toThrow('packages:parent@1.0.0');
});
