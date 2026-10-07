import { describe, expect, it } from 'vitest';
import { companionsOf, type InstalledDependency } from './companions.js';

type Versions = Record<
  string,
  { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
>;

/** The registry as an AI SDK 6 → 7 upgrade sees it: the packages pin the same provider and provider-utils. */
const registry: Record<string, Versions> = {
  ai: {
    '6.0.116': {
      dependencies: { '@ai-sdk/provider': '3.0.3', '@ai-sdk/provider-utils': '4.0.5' },
    },
    '7.0.9': {
      dependencies: { '@ai-sdk/provider': '4.0.1', '@ai-sdk/provider-utils': '5.0.1' },
    },
  },
  '@ai-sdk/provider': { '3.0.3': {}, '4.0.1': {}, '4.0.2': {} },
  '@ai-sdk/react': {
    '3.0.118': { dependencies: { ai: '6.0.116', '@ai-sdk/provider-utils': '4.0.5' } },
    '4.0.10': { dependencies: { ai: '7.0.9', '@ai-sdk/provider-utils': '5.0.1' } },
    '4.0.11': { dependencies: { ai: '7.0.10', '@ai-sdk/provider-utils': '5.0.2' } },
  },
  '@ai-sdk/openai': {
    '3.0.10': { dependencies: { '@ai-sdk/provider': '3.0.3' } },
    '4.0.5': { dependencies: { '@ai-sdk/provider': '4.0.1' } },
    '4.0.6': { dependencies: { '@ai-sdk/provider': '4.0.2' } },
    '5.0.0-beta.1': { dependencies: { '@ai-sdk/provider': '4.0.1' } },
  },
  zod: { '3.25.76': {}, '4.6.5': {} },
};
const manifests = async (name: string) => registry[name] ?? {};
const at = (name: string, version: string, workspaces = ['.']): InstalledDependency => ({
  name,
  version,
  manifest: { name, version, ...registry[name]?.[version] },
  workspaces,
});
const repository = [
  at('ai', '6.0.116'),
  at('@ai-sdk/provider', '3.0.3'),
  at('@ai-sdk/react', '3.0.118'),
  at('@ai-sdk/openai', '3.0.10'),
  at('zod', '3.25.76'),
];

describe('companionsOf', () => {
  it('moves every installed @ai-sdk package with ai to the versions that agree with it', async () => {
    // Before groups, `fix ai` moved ai alone: ai 7 next to @ai-sdk/react 3 and @ai-sdk/openai 3,
    // two copies of @ai-sdk/provider, and an install no lockfile of the real upgrade has.
    const plan = await companionsOf({
      name: 'ai',
      target: '7.0.9',
      installed: repository,
      manifests,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.companions).toEqual([
      {
        name: '@ai-sdk/openai',
        from: '3.0.10',
        to: '4.0.5',
        reason: '@ai-sdk/openai 4.0.5 pins @ai-sdk/provider 4.0.1, as ai 7.0.9 does',
      },
      {
        name: '@ai-sdk/provider',
        from: '3.0.3',
        to: '4.0.1',
        reason: 'ai 7.0.9 pins @ai-sdk/provider 4.0.1',
      },
      {
        name: '@ai-sdk/react',
        from: '3.0.118',
        to: '4.0.10',
        reason: '@ai-sdk/react 4.0.10 pins ai 7.0.9',
      },
    ]);
  });

  it('leaves a package with no companion installed alone', async () => {
    const plan = await companionsOf({
      name: 'zod',
      target: '4.6.5',
      installed: repository,
      manifests,
    });
    expect(plan).toEqual({ companions: [], conflicts: [] });
  });

  it('reports a member with no release that agrees, instead of moving the package alone', async () => {
    const plan = await companionsOf({
      name: 'ai',
      target: '7.0.9',
      installed: repository,
      manifests: async (name) =>
        name === '@ai-sdk/react'
          ? { '3.0.118': registry['@ai-sdk/react']?.['3.0.118'] ?? {} }
          : manifests(name),
    });
    expect(plan.conflicts).toEqual([
      '@ai-sdk/react 3.0.118 has no release that agrees with ai 7.0.9',
    ]);
  });

  it('only groups packages installed in a workspace that has the package', async () => {
    const plan = await companionsOf({
      name: 'ai',
      target: '7.0.9',
      installed: [
        at('ai', '6.0.116', ['apps/web']),
        at('@ai-sdk/react', '3.0.118', ['apps/web']),
        at('@ai-sdk/openai', '3.0.10', ['apps/docs']),
      ],
      manifests,
    });
    expect(plan.companions.map((c) => c.name)).toEqual(['@ai-sdk/react']);
  });
});

describe('companionsOf, a member that already agrees', () => {
  it('stays where it is', async () => {
    // @modelcontextprotocol/sdk takes zod `^3.25 || ^4.0`: zod 4 needs nothing else to move.
    const versions: Versions = {
      '1.28.0': {
        dependencies: { zod: '^3.25 || ^4.0' },
        peerDependencies: { zod: '^3.25 || ^4.0' },
      },
      '1.32.1': {
        dependencies: { zod: '^3.25 || ^4.0' },
        peerDependencies: { zod: '^3.25 || ^4.0' },
      },
    };
    const plan = await companionsOf({
      name: 'zod',
      target: '4.6.5',
      installed: [
        at('zod', '3.25.76'),
        {
          name: '@modelcontextprotocol/sdk',
          version: '1.28.0',
          manifest: { name: '@modelcontextprotocol/sdk', version: '1.28.0', ...versions['1.28.0'] },
          workspaces: ['.'],
        },
      ],
      manifests: async (name) =>
        name === '@modelcontextprotocol/sdk' ? versions : manifests(name),
    });
    expect(plan).toEqual({ companions: [], conflicts: [] });
  });
});
