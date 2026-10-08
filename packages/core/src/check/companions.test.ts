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
    expect(plan).toEqual({ companions: [], conflicts: [], peerConflicts: [] });
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
    expect(plan).toEqual({ companions: [], conflicts: [], peerConflicts: [] });
  });
});

describe('companionsOf, react 18 → 19', () => {
  /** The registry as the upgrade sees it: react-dom peer-requires react at its own version, the types track minors. */
  const react: Record<string, Versions> = {
    react: { '18.2.0': {}, '18.3.1': {}, '19.0.0': {}, '19.2.1': {}, '19.3.0': {} },
    'react-dom': {
      '18.2.0': { dependencies: { scheduler: '^0.23.0' }, peerDependencies: { react: '^18.2.0' } },
      '18.3.1': { dependencies: { scheduler: '^0.23.2' }, peerDependencies: { react: '^18.3.1' } },
      '19.0.0': { dependencies: { scheduler: '0.25.0' }, peerDependencies: { react: '^19.0.0' } },
      '19.2.1': { dependencies: { scheduler: '0.27.0' }, peerDependencies: { react: '^19.2.1' } },
      '19.3.0': { dependencies: { scheduler: '0.28.0' }, peerDependencies: { react: '^19.3.0' } },
    },
    '@types/react': {
      '18.2.0': { dependencies: { csstype: '^3.0.2' } },
      '18.3.31': { dependencies: { csstype: '^3.0.2' } },
      '19.0.10': { dependencies: { csstype: '^3.0.2' } },
      '19.0.14': { dependencies: { csstype: '^3.0.2' } },
      '19.2.7': { dependencies: { csstype: '^3.0.2' } },
      '19.3.0': { dependencies: { csstype: '^3.0.2' } },
    },
    '@types/react-dom': {
      '18.2.0': { dependencies: { '@types/react': '*' } },
      '19.0.4': { peerDependencies: { '@types/react': '^19.0.0' } },
      '19.2.3': { peerDependencies: { '@types/react': '^19.0.0' } },
    },
    scheduler: { '0.23.0': {}, '0.25.0': {} },
  };
  const manifests = async (name: string) => react[name] ?? {};
  const installed = (name: string, version: string, workspaces: string[]): InstalledDependency => ({
    name,
    version,
    manifest: { name, version, ...react[name]?.[version] },
    workspaces,
  });

  it('moves react-dom, @types/react and @types/react-dom with react, the types from the root', async () => {
    // excalidraw: the app declares react and react-dom, the root declares the types for everyone.
    const plan = await companionsOf({
      name: 'react',
      target: '19.0.0',
      installed: [
        installed('react', '18.2.0', ['excalidraw-app']),
        installed('react-dom', '18.2.0', ['excalidraw-app']),
        installed('@types/react', '18.2.0', ['.']),
        installed('@types/react-dom', '18.2.0', ['.']),
        installed('scheduler', '0.23.0', ['excalidraw-app']),
      ],
      manifests,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.companions).toEqual([
      {
        name: '@types/react',
        from: '18.2.0',
        to: '19.0.14',
        reason: '@types/react 19.0.14 types react 19.0.0',
      },
      {
        name: '@types/react-dom',
        from: '18.2.0',
        to: '19.0.4',
        reason: '@types/react-dom 19.0.4 types react-dom 19.0.0',
      },
      {
        name: 'react-dom',
        from: '18.2.0',
        to: '19.0.0',
        reason: 'react-dom 19.0.0 is released with react 19.0.0 (peer ^19.0.0)',
      },
    ]);
    expect(plan.reason).toBe('peer link, types for react, react-dom');
  });

  it('moves a lockstep companion even when its installed copy accepts the target', async () => {
    const plan = await companionsOf({
      name: 'react',
      target: '19.2.1',
      installed: [
        installed('react', '18.3.1', ['.']),
        {
          ...installed('react-dom', '18.3.1', ['.']),
          manifest: { peerDependencies: { react: '^18.3.1 || ^19.0.0' } },
        },
        installed('@types/react', '18.3.31', ['.']),
      ],
      manifests: async (name) =>
        name === 'react-dom'
          ? {
              ...react['react-dom'],
              '18.3.1': { peerDependencies: { react: '^18.3.1 || ^19.0.0' } },
            }
          : manifests(name),
    });
    expect(plan.companions.map((c) => `${c.name} ${c.to}`)).toEqual([
      '@types/react 19.2.7',
      'react-dom 19.2.1',
    ]);
  });

  it('leaves a package whose peer range rejects the target in place and reports it as a peer conflict', async () => {
    // next-mdx-remote-client 1.x peers react `>= 18.3.0 < 19.0.0`: the real upgrade kept it at
    // 1.1.2. It is not released with react (no 19.2.1), so nothing moves it, and nothing is
    // compiled at another version of it.
    const mdx = {
      '1.1.2': { peerDependencies: { react: '>= 18.3.0 < 19.0.0' } },
      '2.0.0': { peerDependencies: { react: '>=19.0.0' } },
      '2.1.12': { peerDependencies: { react: '>= 19.1.0' } },
    };
    const plan = await companionsOf({
      name: 'react',
      target: '19.2.1',
      installed: [
        installed('react', '18.3.1', ['apps/docs']),
        {
          ...installed('next-mdx-remote-client', '1.1.2', ['apps/docs']),
          manifest: mdx['1.1.2'],
        },
        {
          ...installed('react-dom', '18.3.1', ['apps/docs']),
          manifest: { peerDependencies: { react: '^18.3.1' } },
        },
      ],
      manifests: async (name) =>
        name === 'next-mdx-remote-client'
          ? mdx
          : name === 'react-dom'
            ? { ...react['react-dom'], '18.3.1': { peerDependencies: { react: '^18.3.1' } } }
            : manifests(name),
    });
    expect(plan.peerConflicts).toEqual([
      'next-mdx-remote-client 1.1.2 declares react >= 18.3.0 < 19.0.0',
    ]);
    // Not an upgrade that cannot agree, and not moved: only the release-group member moves.
    expect(plan.conflicts).toEqual([]);
    expect(plan.companions.map((c) => `${c.name} ${c.to}`)).toEqual(['react-dom 19.2.1']);
  });

  it('moves a package the pack names even when its installed peer range accepts the target', async () => {
    // No release of it at the target's version, so only the pack's list moves it.
    const wrapper = {
      '2.0.0': { peerDependencies: { react: '^18 || ^19' } },
      '2.1.0': { peerDependencies: { react: '^18 || ^19' } },
    };
    const input = {
      name: 'react',
      target: '19.2.1',
      installed: [
        installed('react', '18.3.1', ['.']),
        { ...installed('react-wrapper', '2.0.0', ['.']), manifest: wrapper['2.0.0'] },
      ],
      manifests: async (name: string) => (name === 'react-wrapper' ? wrapper : manifests(name)),
    };
    const alone = await companionsOf(input);
    expect(alone.companions).toEqual([]);
    expect(alone.peerConflicts).toEqual([]);
    const named = await companionsOf({ ...input, lockstep: ['react-wrapper'] });
    expect(named.companions.map((c) => `${c.name} ${c.from} → ${c.to}`)).toEqual([
      'react-wrapper 2.0.0 → 2.1.0',
    ]);
  });

  it('leaves a types package declared in an unrelated workspace alone', async () => {
    const plan = await companionsOf({
      name: 'react',
      target: '19.0.0',
      installed: [
        installed('react', '18.2.0', ['apps/web']),
        installed('@types/react', '18.2.0', ['apps/docs']),
      ],
      manifests,
    });
    expect(plan).toEqual({ companions: [], conflicts: [], peerConflicts: [] });
  });
});
