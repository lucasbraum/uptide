import { expect, it } from 'vitest';
import type { Manifest } from './evidence.js';
import { dependencyGroups } from './groups.js';
import type { ListedDependency } from './list.js';

function pkg(name: string, current = '1.0.0', latest = '2.0.0'): ListedDependency {
  return {
    name,
    current,
    latest,
    change: 'major',
    majorGap: 1,
    tier: 'generic',
    classification: name.includes('/cli') || name.includes('/schematics') ? 'tooling' : 'used',
    reasons: [],
    workspaces: ['.'],
    usage: { files: 1, callSites: 1, references: 0, topSymbols: [], workspaces: [] },
  };
}

it('names the lockstep scope and independent tooling leads with unique matching selectors', () => {
  const packages = [
    pkg('@nestjs/common'),
    pkg('@nestjs/core'),
    pkg('@nestjs/cli', '10.0.0', '12.0.0'),
    pkg('@nestjs/schematics', '10.1.0', '12.1.0'),
    pkg('cli-peer'),
    pkg('schematics-peer'),
  ];
  const groups = dependencyGroups(
    packages,
    new Map(),
    new Map<string, Manifest>([
      ['@nestjs/cli', { peerDependencies: { 'cli-peer': '^2' } }],
      ['@nestjs/schematics', { peerDependencies: { 'schematics-peer': '^2' } }],
    ]),
  );
  expect(groups.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'nestjs', name: '@nestjs/*' },
    { id: '@nestjs/cli', name: '@nestjs/cli' },
    { id: '@nestjs/schematics', name: '@nestjs/schematics' },
  ]);
  expect(groups[1]?.members.find((p) => p.name === 'cli-peer')?.peerOf).toEqual(['@nestjs/cli']);
});

it('does not name a peer-coupled set as lockstep when its scoped versions differ', () => {
  const groups = dependencyGroups(
    [pkg('@example/lead'), pkg('@example/peer', '3.0.0', '4.0.0')],
    new Map([['@example/lead', [{ peerDependencies: { '@example/peer': '^3' } }]]]),
  );
  expect(groups[0]).toMatchObject({ id: '@example/lead', name: '@example/lead' });
});

it('keeps selectors unique when an unscoped lead matches a scope shorthand', () => {
  const groups = dependencyGroups(
    [pkg('@example/a'), pkg('@example/b'), pkg('example'), pkg('peer')],
    new Map(),
    new Map([['example', { peerDependencies: { peer: '^2' } }]]),
  );
  expect(groups.map((g) => g.id)).toEqual(['@example/*', 'example']);
});
