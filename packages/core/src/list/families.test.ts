import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listDependencies } from './list.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A copy of the fixture, and a registry answering from its recorded `registry.json`. */
function fixture(name: string) {
  const cwd = mkdtempSync(join(tmpdir(), `uptide-${name}-`));
  roots.push(cwd);
  cpSync(
    fileURLToPath(new URL(`../../../../fixtures/repos/list-accuracy/${name}/`, import.meta.url)),
    cwd,
    { recursive: true },
  );
  const registry = JSON.parse(readFileSync(join(cwd, 'registry.json'), 'utf8')) as Record<
    string,
    {
      latest: string;
      versions: Record<
        string,
        {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          deprecated?: string;
        }
      >;
    }
  >;
  const entry = (n: string) => {
    const found = registry[n];
    if (!found) throw new Error(`${n}: not in the fixture registry`);
    return found;
  };
  return {
    cwd,
    fetcher: {
      resolve: async (n: string) => entry(n).latest,
      metadata: async (n: string, v: string) => ({
        peerDependencies: {},
        ...entry(n).versions[v],
      }),
      deprecation: async (n: string, v: string) => entry(n).versions[v]?.deprecated,
      versions: async (n: string) => Object.keys(entry(n).versions),
    },
  };
}

it('groups a scope as one family named after it, whatever version each member is at', async () => {
  const { cwd, fetcher } = fixture('radix-family');
  const report = await listDependencies({ cwd, fetcher });
  // react-icons 1.3.0 caps React at 18: that blocks React 19, but React stays out of the group.
  expect(report.packages.find((p) => p.name === '@radix-ui/react-icons')?.signals?.blocks).toEqual([
    'react 19',
  ]);
  expect(
    report.groups.map((g) => ({
      id: g.id,
      name: g.name,
      reason: g.reason,
      members: g.members.map((p) => `${p.name}@${p.current}`),
    })),
  ).toEqual([
    {
      id: 'radix-ui',
      name: '@radix-ui/*',
      reason: '@radix-ui family',
      members: [
        '@radix-ui/react-dialog@1.0.5',
        '@radix-ui/react-icons@1.3.0',
        '@radix-ui/react-popover@1.0.7',
        '@radix-ui/react-slot@1.0.2',
      ],
    },
  ]);
});

it('groups ai with the @ai-sdk providers it shares pins with, and says why', async () => {
  const { cwd, fetcher } = fixture('ai-sdk-link');
  const report = await listDependencies({ cwd, fetcher });
  expect(report.groups).toHaveLength(1);
  const group = report.groups[0];
  expect(group).toMatchObject({ id: 'ai', lead: 'ai', name: 'ai + @ai-sdk/*' });
  expect(group?.members.map((p) => p.name).sort()).toEqual([
    '@ai-sdk/anthropic',
    '@ai-sdk/openai',
    '@ai-sdk/react',
    'ai',
  ]);
  expect(group?.reason).toBe('shared @ai-sdk/provider, shared @ai-sdk/provider-utils');
  // ai 4's peer range on zod (^3.23.8) holds zod 4 back: a blocking signal, not a group,
  // since ai's latest accepts the installed zod 3 too.
  expect(report.packages.find((p) => p.name === 'ai')?.signals?.blocks).toEqual(['zod 4']);
  expect(report.priorities?.[0]).toMatchObject({
    name: 'ai + @ai-sdk/*',
    group: 'ai',
    signal: 'blocking',
  });
});
