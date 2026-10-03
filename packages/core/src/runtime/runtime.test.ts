import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffRuntime, nodeBinaryFor, probeRuntime } from './runtime.js';

const DEPS = resolve(import.meta.dirname, '../../../../fixtures/deps');
const scratch = mkdtempSync(join(tmpdir(), 'uptide-runtime-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const opts = { dependenciesFrom: join(scratch, 'node_modules'), noCache: true };

describe('probeRuntime', () => {
  it('describes a CommonJS function export with its keys', async () => {
    const surface = await probeRuntime(join(DEPS, 'plain-v1'), opts);
    expect(surface.inconclusive).toBeUndefined();
    expect(surface.require.ok).toBe(true);
    expect(surface.require.callable).toBe(true);
    expect(surface.require.keys).toMatchObject({ hello: 'function', legacy: 'function' });
    expect(surface.import.ok).toBe(true);
    expect(surface.import.defaultCallable).toBe(true);
    expect(surface.nodeSource).toBe('current');
  });

  it('describes an ESM package through both loaders', async () => {
    const surface = await probeRuntime(join(DEPS, 'plain-esm-v3'), opts);
    expect(surface.import.ok).toBe(true);
    expect(surface.import.keys).toMatchObject({ hello: 'function', default: 'function' });
    expect(surface.import.callable).toBeUndefined();
    // Node 22.12+ loads ESM through require(); older lines throw ERR_REQUIRE_ESM. Either is recorded.
    if (surface.require.ok) expect(surface.require.defaultCallable).toBe(true);
    else expect(surface.require.code).toBe('ERR_REQUIRE_ESM');
  });

  it('is inconclusive for a package with an install script', async () => {
    const surface = await probeRuntime(join(DEPS, 'native-like'), opts);
    expect(surface.inconclusive).toMatch(/install script/);
  });

  it('is inconclusive when a dependency is not available to the probe', async () => {
    const dir = join(scratch, 'needs-dep');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'needs-dep', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), "module.exports = require('not-installed-anywhere');");
    const surface = await probeRuntime(dir, opts);
    expect(surface.inconclusive).toMatch(/not-installed-anywhere/);
  });

  it('provides the consumer dependencies to the package', async () => {
    const modules = join(scratch, 'node_modules');
    mkdirSync(modules, { recursive: true });
    symlinkSync(join(DEPS, 'plain-v1'), join(modules, 'plain'), 'dir');
    const dir = join(scratch, 'uses-dep');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'uses-dep', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), "module.exports = { greet: require('plain').hello };");
    const surface = await probeRuntime(dir, opts);
    expect(surface.inconclusive).toBeUndefined();
    expect(surface.require.keys).toEqual({ greet: 'function' });
  });

  it('cannot write files or reach the network from inside the package', async () => {
    const dir = join(scratch, 'naughty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'naughty', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(dir, 'index.js'),
      // The probe records export keys, so the outcome of each attempt is encoded in a key name.
      `const r = {};
try { require('fs').writeFileSync(__dirname + '/x', ''); r['write:ok'] = 1; } catch (e) { r['write:' + e.code] = 1; }
try { require('net').connect(80, 'example.com'); r['net:ok'] = 1; } catch (e) { r['net:' + e.code] = 1; }
try { require('child_process').execSync('true'); r['spawn:ok'] = 1; } catch (e) { r['spawn:' + e.code] = 1; }
module.exports = r;`,
    );
    const surface = await probeRuntime(dir, opts);
    expect(surface.inconclusive).toBeUndefined();
    expect(Object.keys(surface.require.keys ?? {}).sort()).toEqual([
      'net:ERR_UPTIDE_NO_NET',
      'spawn:ERR_ACCESS_DENIED',
      'write:ERR_ACCESS_DENIED',
    ]);
  });
});

describe('probeRuntime with a dependency resolver', () => {
  it("asks for a missing dependency at the importer's declared range and retries", async () => {
    const dir = join(scratch, 'needs-plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'needs-plain',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { plain: '^1.0.0' },
      }),
    );
    writeFileSync(join(dir, 'index.js'), "module.exports = { greet: require('plain').hello };");
    const asked: string[] = [];
    const surface = await probeRuntime(dir, {
      dependenciesFrom: join(scratch, 'none'),
      noCache: true,
      resolveDependency: async (dep, range) => {
        asked.push(`${dep}@${range}`);
        return dep === 'plain' ? join(DEPS, 'plain-v1') : undefined;
      },
    });
    expect(asked).toEqual(['plain@^1.0.0']);
    expect(surface.inconclusive).toBeUndefined();
    expect(surface.require.keys).toEqual({ greet: 'function' });
    // Nothing to offer: inconclusive, naming the dependency and range.
    const none = await probeRuntime(dir, {
      dependenciesFrom: join(scratch, 'none'),
      noCache: true,
      resolveDependency: async () => undefined,
    });
    expect(none.inconclusive).toBe('dependency "plain@^1.0.0" could not be provided to the probe');
  });
});

describe('diffRuntime', () => {
  it('reports the CJS function to ESM namespace change and the dropped key', async () => {
    const before = await probeRuntime(join(DEPS, 'plain-v1'), opts);
    const after = await probeRuntime(join(DEPS, 'plain-esm-v3'), opts);
    const diff = diffRuntime(before, after);
    const kinds = diff.changes.map((c) => `${c.loader}:${c.kind}${c.key ? `:${c.key}` : ''}`);
    expect(kinds).toContain('require:key-removed:legacy');
    expect(
      kinds.some((k) => k === 'require:namespace-instead' || k === 'require:require-throws'),
    ).toBe(true);
    expect(kinds).toContain('import:key-removed:legacy');
    // `default` remained callable under import(): nothing lost there.
    expect(kinds).not.toContain('import:callable-lost');
  });

  it('is inconclusive when either side was', async () => {
    const before = await probeRuntime(join(DEPS, 'plain-v1'), opts);
    const after = await probeRuntime(join(DEPS, 'native-like'), opts);
    expect(diffRuntime(before, after)).toEqual({
      changes: [],
      inconclusive: expect.stringMatching(/target copy/),
    });
  });
});

describe('nodeBinaryFor', () => {
  it('picks the highest installed release of the major from a version manager layout', () => {
    const home = join(scratch, 'home');
    for (const v of ['v22.3.0', 'v22.12.0', 'v20.19.0']) {
      mkdirSync(join(home, '.nvm/versions/node', v, 'bin'), { recursive: true });
      writeFileSync(join(home, '.nvm/versions/node', v, 'bin/node'), '');
    }
    expect(nodeBinaryFor(22, home)?.version).toBe('v22.12.0');
    expect(nodeBinaryFor(18, home)).toBeUndefined();
  });
});

it('persists a version/Node-major probe across calls and ignores legacy cache entries', async () => {
  const dir = join(scratch, 'cached-package');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'cached-package', version: '1.0.0' }),
  );
  writeFileSync(join(dir, 'index.js'), 'exports.original = 1;');
  const cacheDir = join(scratch, 'cache');
  const first = await probeRuntime(dir, { dependenciesFrom: scratch, cacheDir });
  writeFileSync(join(dir, 'index.js'), 'throw new Error("cache was not used");');
  const next = await probeRuntime(dir, { dependenciesFrom: scratch, cacheDir });
  expect(next).toEqual(first);
  expect(next.require.keys).toEqual({ original: 'number' });
  const file = join(
    cacheDir,
    'runtime',
    'cached-package',
    `1.0.0-node${process.versions.node.split('.')[0]}.json`,
  );
  writeFileSync(file, JSON.stringify({ ...first, inconclusive: 'old dependency resolver failed' }));
  writeFileSync(join(dir, 'index.js'), 'exports.fresh = 1;');
  const refreshed = await probeRuntime(dir, { dependenciesFrom: scratch, cacheDir });
  expect(refreshed.require.keys).toEqual({ fresh: 'number' });
});
