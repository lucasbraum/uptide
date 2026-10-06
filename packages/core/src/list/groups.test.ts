import { expect, it } from 'vitest';
import type { Manifest } from './evidence.js';
import { dependencyGroups, peerBlocks } from './groups.js';
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

it('makes a scope one family, with the peers its latest versions need', () => {
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
  expect(groups.map(({ id, name, reason }) => ({ id, name, reason }))).toEqual([
    { id: 'nestjs', name: '@nestjs/*', reason: '@nestjs family, peer link' },
  ]);
  expect(groups[0]?.members.find((p) => p.name === 'cli-peer')?.peerOf).toEqual(['@nestjs/cli']);
});

it('keeps a family together when its members are at different versions', () => {
  const groups = dependencyGroups(
    [pkg('@example/lead'), pkg('@example/peer', '3.0.0', '4.0.0')],
    new Map(),
  );
  expect(groups[0]).toMatchObject({ id: 'example', name: '@example/*', reason: '@example family' });
});

it('never makes @types a family, and keeps a scope split across workspaces apart', () => {
  const inWorkspace = (name: string, workspace: string): ListedDependency => ({
    ...pkg(name),
    workspaces: [workspace],
  });
  const groups = dependencyGroups(
    [
      pkg('@types/node'),
      pkg('@types/react'),
      inWorkspace('@ui/a', 'web'),
      inWorkspace('@ui/b', 'web'),
      inWorkspace('@ui/c', 'admin'),
      inWorkspace('@ui/d', 'admin'),
    ],
    new Map(),
  );
  expect(groups.map((g) => [g.id, g.name])).toEqual([
    ['@ui/a', '@ui/*'],
    ['@ui/c', '@ui/*'],
  ]);
});

it('reports an installed peer range that holds another outdated package back', () => {
  const blocks = peerBlocks(
    [
      pkg('@ai-sdk/react', '1.2.12', '4.0.0'),
      pkg('react', '18.3.1', '19.2.0'),
      pkg('zod', '3.25.0', '4.1.0'),
    ],
    new Map([['@ai-sdk/react', [{ peerDependencies: { react: '^18 || ^19', zod: '^3.23.8' } }]]]),
  );
  expect([...blocks]).toEqual([['@ai-sdk/react', ['zod 4']]]);
});

it('keeps selectors unique when an unscoped lead matches a scope shorthand', () => {
  const groups = dependencyGroups(
    [pkg('@example/a'), pkg('@example/b'), pkg('example'), pkg('peer')],
    new Map(),
    new Map([['example', { peerDependencies: { peer: '^2' } }]]),
  );
  expect(groups.map((g) => g.id)).toEqual(['@example/*', 'example']);
});

it('names a mixed group after its hub on a tie, even when a family member is used more', () => {
  // ai shares a pinned dependency with one @ai-sdk member only; that member is used in more
  // files. Each has one link outside its family: ai, in no family and nobody's peer, leads.
  const used = (name: string, files: number): ListedDependency => ({
    ...pkg(name, '4.0.0', '7.0.0'),
    usage: { files, callSites: files, references: 0, topSymbols: [], workspaces: [] },
  });
  const groups = dependencyGroups(
    [used('ai', 1), used('@ai-sdk/openai-compatible', 9), used('@ai-sdk/react', 3)],
    new Map([
      ['ai', [{ dependencies: { '@ai-sdk/provider': '1.1.3' } }]],
      ['@ai-sdk/openai-compatible', [{ dependencies: { '@ai-sdk/provider': '1.1.3' } }]],
    ]),
    new Map<string, Manifest>([
      ['ai', { dependencies: { '@ai-sdk/provider': '4.0.22' } }],
      ['@ai-sdk/openai-compatible', { dependencies: { '@ai-sdk/provider': '4.0.22' } }],
    ]),
  );
  expect(groups.map(({ id, name, lead, reason }) => ({ id, name, lead, reason }))).toEqual([
    { id: 'ai', name: 'ai + @ai-sdk/*', lead: 'ai', reason: 'shared @ai-sdk/provider' },
  ]);
});
