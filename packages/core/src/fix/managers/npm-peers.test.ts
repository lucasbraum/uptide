import { expect, it } from 'vitest';
import { assertLockScope } from './lock-guard.js';
import { npmGraph, npmPeerReresolutions } from './npm-lock.js';

function fixture(version = '1.2.0', range = '^1', peer = 'target', v = 3) {
  const before = {
    lockfileVersion: v,
    packages: {
      '': { dependencies: { target: '^1', plugin: range, unrelated: '^1' } },
      'node_modules/target': { version: '1.0.0' },
      'node_modules/plugin': { version: '1.1.0', peerDependencies: { [peer]: '^1 || ^2' } },
      'node_modules/unrelated': { version: '1.0.0' },
    },
    ...(v === 2
      ? {
          dependencies: {
            target: { version: '1.0.0' },
            plugin: { version: '1.1.0' },
            unrelated: { version: '1.0.0' },
          },
        }
      : {}),
  };
  const after = structuredClone(before);
  after.packages[''].dependencies.target = '^2';
  after.packages['node_modules/target'].version = '2.0.0';
  after.packages['node_modules/plugin'].version = version;
  if (after.dependencies) {
    after.dependencies.target.version = '2.0.0';
    after.dependencies.plugin.version = version;
  }
  return { before, after };
}
const graph = (lock: unknown) => npmGraph(JSON.stringify(lock), ['target']);

it.each([2, 3])(
  'admits only an in-range reverse peer in npm v%s, with an auditable reason',
  (v) => {
    const { before, after } = fixture('1.2.0', '^1', 'target', v);
    const peers = npmPeerReresolutions(graph(before), graph(after), ['target']);
    expect(peers).toEqual([
      {
        name: 'plugin',
        from: '1.1.0',
        to: '1.2.0',
        peers: ['target'],
        ranges: { '. (dependencies)': '^1' },
        records: ['node_modules/plugin', ...(v === 2 ? ['legacy/node_modules/plugin'] : [])],
      },
    ]);
    expect(() =>
      assertLockScope(
        graph(before),
        graph(after),
        ['target'],
        peers.flatMap((p) => p.records),
      ),
    ).not.toThrow();
    after.packages['node_modules/unrelated'].version = '1.1.0';
    expect(() =>
      assertLockScope(
        graph(before),
        graph(after),
        ['target'],
        peers.flatMap((p) => p.records),
      ),
    ).toThrow('node_modules/unrelated');
  },
);

it.each([
  ['major', '2.0.0', '*', 'target'],
  ['downgrade', '1.0.0', '^1', 'target'],
  ['outside declared range', '1.2.0', '~1.1.0', 'target'],
  ['no planned peer', '1.2.0', '^1', 'other'],
])('rejects %s re-resolution', (_reason, version, range, peer) => {
  const { before, after } = fixture(version, range, peer);
  expect(npmPeerReresolutions(graph(before), graph(after), ['target'])).toEqual([]);
  expect(() => assertLockScope(graph(before), graph(after), ['target'])).toThrow(
    'node_modules/plugin',
  );
});

it('requires every old consumer range and a peer declared before the upgrade', () => {
  const { before, after } = fixture();
  Object.assign(before.packages['node_modules/unrelated'], { dependencies: { plugin: '1.1.0' } });
  Object.assign(after.packages['node_modules/unrelated'], { dependencies: { plugin: '1.1.0' } });
  expect(npmPeerReresolutions(graph(before), graph(after), ['target'])).toEqual([]);
  const newlyDeclared = fixture('1.2.0', '^1', 'other');
  newlyDeclared.after.packages['node_modules/plugin'].peerDependencies = { target: '^2' };
  expect(
    npmPeerReresolutions(graph(newlyDeclared.before), graph(newlyDeclared.after), ['target']),
  ).toEqual([]);
});

it('does not exempt same-version integrity changes or unrelated copies by package name', () => {
  const { before, after } = fixture('1.1.0');
  Object.assign(after.packages['node_modules/plugin'], { integrity: 'changed' });
  expect(npmPeerReresolutions(graph(before), graph(after), ['target'])).toEqual([]);
  expect(() => assertLockScope(graph(before), graph(after), ['target'])).toThrow(
    'node_modules/plugin',
  );
  const pair = fixture();
  Object.assign(pair.before.packages, {
    'node_modules/unrelated/node_modules/plugin': { version: '1.0.0' },
  });
  Object.assign(pair.after.packages, {
    'node_modules/unrelated/node_modules/plugin': { version: '2.0.0' },
  });
  const peers = npmPeerReresolutions(graph(pair.before), graph(pair.after), ['target']);
  expect(() =>
    assertLockScope(
      graph(pair.before),
      graph(pair.after),
      ['target'],
      peers.flatMap((p) => p.records),
    ),
  ).toThrow('node_modules/unrelated/node_modules/plugin');
});

it('retains an exact-pinned old transitive copy for an unchanged outside consumer', () => {
  const { before, after } = fixture();
  Object.assign(before.packages['node_modules/plugin'], { dependencies: { shared: '1.0.0' } });
  Object.assign(after.packages['node_modules/plugin'], { dependencies: { shared: '2.0.0' } });
  for (const lock of [before, after])
    Object.assign(lock.packages['node_modules/unrelated'], { dependencies: { shared: '1.0.0' } });
  Object.assign(before.packages, { 'node_modules/shared': { version: '1.0.0', integrity: 'one' } });
  Object.assign(after.packages, {
    'node_modules/shared': { version: '2.0.0', integrity: 'two' },
    'node_modules/unrelated/node_modules/shared': { version: '1.0.0', integrity: 'one' },
  });
  const peers = npmPeerReresolutions(graph(before), graph(after), ['target']);
  expect(() =>
    assertLockScope(
      graph(before),
      graph(after),
      ['target'],
      peers.flatMap((p) => p.records),
    ),
  ).not.toThrow();
  delete (after.packages as Record<string, unknown>)['node_modules/unrelated/node_modules/shared'];
  expect(() =>
    assertLockScope(
      graph(before),
      graph(after),
      ['target'],
      peers.flatMap((p) => p.records),
    ),
  ).toThrow('node_modules/unrelated');
});
