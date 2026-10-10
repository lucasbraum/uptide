import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { isolatedFix } from './isolate.js';
import { git } from './process.js';
import { rangePreflight } from './range-preflight.js';
import { fix } from './run.js';
import { zodFixture } from './test-fixture.js';
import { bumpCatalog, bumpVersions, validateVersionRanges, versionRange } from './versions.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-ranges-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it.each([
  ['^18', '^19'],
  ['18', '19'],
  ['18.x', '19.x'],
  ['^18.x', '^19.x'],
  ['~18', '~19'],
  ['~18.2', '~19.3'],
  ['18.2.x', '19.3.x'],
  ['^18.2', '^19.3'],
  ['18.2', '19.3'],
  ['18.X', '19.X'],
  ['18.*', '19.*'],
  ['18.x.x', '19.x.x'],
  ['18.2.0', '19.3.4'],
  ['^18.2.0', '^19.3.4'],
  ['~18.2.0', '~19.3.4'],
  ['^18.2.0-beta.1+build', '^19.3.4'],
  ['v18', 'v19'],
  ['^ 18.2', '^ 19.3'],
  ['npm:react@^18', 'npm:react@^19'],
  ['npm:@scope/react@~18.2', 'npm:@scope/react@~19.3'],
])('rewrites %s as %s', (before, expected) => {
  expect(versionRange(before, '19.3.4')).toBe(expected);
});

const unsupported = [
  '>=18 <20',
  '18 || 19',
  '18 - 19',
  '*',
  'latest',
  'workspace:^18',
  'workspace:*',
  'npm:react@>=18 <20',
  'npm:react@18 || 19',
  'npm:react@*',
  'npm:react@latest',
  'npm:react',
  'file:../react',
  'link:../react',
  '18.x.2',
  '18.2.0.1',
  '18-beta',
  '18.2.x-beta',
  'npm:@scope/react@18 || 19',
];
it.each(unsupported)('rejects unsupported %s', (before) => {
  expect(() => versionRange(before, '19.3.4')).toThrow(/Cannot preserve version range/);
});

it('keeps the target prerelease for full precision and changes the requested minor only', () => {
  expect(versionRange('^18.2.0', '19.2.0-rc.1')).toBe('^19.2.0-rc.1');
  expect(versionRange('~18.2', '19.2.5')).toBe('~19.2');
});

function reactFixture() {
  const root = mkdtempSync(join(scratch, 'react-'));
  cpSync(
    fileURLToPath(new URL('__fixtures__/react-partial/package.json', import.meta.url)),
    join(root, 'package.json'),
  );
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom']) {
    put(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: '18.3.1',
        ...(name === 'react-dom' ? { peerDependencies: { react: '^18.3.1' } } : {}),
      }),
    );
  }
  put('.gitignore', 'node_modules\n');
  put('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return { root, put };
}

it('bumps react, react-dom and both types companions with their own precision', () => {
  const { root } = reactFixture();
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom'])
    bumpVersions(root, name, '19.3.4');
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
    dependencies: { react: '^19', 'react-dom': '^19' },
    devDependencies: { '@types/react': '~19.3', '@types/react-dom': '19.3.x' },
  });
});

it('bumps workspace declarations and default/named catalogs without replacing references', () => {
  const { root, put } = reactFixture();
  put(
    'pnpm-workspace.yaml',
    'packages: [packages/*]\ncatalog:\n  react: "^18" # keep\ncatalogs:\n  legacy:\n    react-dom: ~18.2\n',
  );
  put(
    'packages/a/package.json',
    JSON.stringify({ dependencies: { react: 'catalog:', 'react-dom': 'catalog:legacy' } }),
  );
  put(
    'packages/b/package.json',
    JSON.stringify({ peerDependencies: { react: '18.x', 'react-dom': '^18.2' } }),
  );
  for (const name of ['react', 'react-dom']) bumpVersions(root, name, '19.3.4');
  expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('react: "^19" # keep');
  expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('react-dom: ~19.3');
  expect(
    JSON.parse(readFileSync(join(root, 'packages/a/package.json'), 'utf8')).dependencies,
  ).toEqual({ react: 'catalog:', 'react-dom': 'catalog:legacy' });
  expect(
    JSON.parse(readFileSync(join(root, 'packages/b/package.json'), 'utf8')).peerDependencies,
  ).toEqual({ react: '19.x', 'react-dom': '^19.3' });
});

it.each(['>=18 <20', 'workspace:*', 'npm:react@18 || 19'])(
  'refuses %s before cloning, checking, branching or spending, including --pr',
  async (range) => {
    const { root, services } = zodFixture(scratch);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: range } }));
    git(root, 'commit', '-am', 'unsupported range');
    const branches = git(root, 'branch');
    const runs = join(scratch, 'runs');
    vi.stubEnv('UPTIDE_RUNS_DIR', runs);
    const before = existsSync(runs) ? readdirSync(runs) : [];
    const check = vi.fn(services.check),
      install = vi.fn(services.install),
      spend = vi.fn();
    try {
      await expect(
        isolatedFix(
          {
            cwd: root,
            only: 'zod',
            pr: true,
            yes: true,
            fixer: { id: 'test', fix: spend },
            tool: { uptideDirty: false, uptideCommit: 'a'.repeat(40), uptideVersion: '0.6.1' },
          },
          { ...services, check, install },
        ),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_VERSION_RANGE',
        message: expect.stringContaining(
          `package.json: dependencies.zod declares ${JSON.stringify(range)}`,
        ),
      });
      expect(check).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
      expect(git(root, 'branch')).toBe(branches);
      expect(existsSync(runs) ? readdirSync(runs) : []).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('names the file, field, range and installed-version suggestion before any workspace writes', () => {
  const { root, put } = reactFixture();
  put('pnpm-workspace.yaml', 'packages: [packages/*]\n');
  put('packages/app/package.json', '{"dependencies":{"react":">=18 <20"}}');
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  expect(() => bumpVersions(root, 'react', '19.3.4')).toThrow(
    'Change "react": ">=18 <20" in packages/app/package.json (dependencies.react) to "^18.3.1", then rerun.',
  );
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
});

it('names unsupported catalog entries and preserves the alias in its suggestion', () => {
  expect(() =>
    bumpCatalog('catalog:\n  react: ">=18 <20"\n', 'react', '19.3.4', '', '18.3.1'),
  ).toThrow('pnpm-workspace.yaml (catalog.react) to "^18.3.1"');
  const { root, put } = reactFixture();
  put('package.json', '{"dependencies":{"react":"npm:react@18 || 19"}}');
  expect(() => validateVersionRanges(root, ['react'])).toThrow(
    'to "npm:react@^18.3.1", then rerun.',
  );
});

it('validates the committed manifest, not an uncommitted repair, before cloning', async () => {
  const { root, services } = zodFixture(scratch);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"zod":">=3 <5"}}');
  git(root, 'commit', '-am', 'complex');
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"zod":"^3"}}');
  await expect(isolatedFix({ cwd: root, only: 'zod' }, services)).rejects.toThrow(
    'dependencies.zod declares ">=3 <5"',
  );
});

it('finds unsupported lockstep and types companions before cloning, but allows unrelated complex ranges', async () => {
  const registry = async (name: string) => ({
    '18.3.1': name === 'react-dom' ? { peerDependencies: { react: '^18.3.1' } } : {},
    '19.3.4': name === 'react-dom' ? { peerDependencies: { react: '^19.3.4' } } : {},
  });
  for (const name of ['react-dom', '@types/react', '@types/react-dom']) {
    const { root, put } = reactFixture();
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    (name.startsWith('@') ? json.devDependencies : json.dependencies)[name] = '>=18 <20';
    put('package.json', JSON.stringify(json));
    git(root, 'commit', '-am', 'complex companion');
    const services = { ...zodFixture(scratch).services, manifests: registry };
    services.check = vi.fn(services.check);
    await expect(
      isolatedFix({ cwd: root, only: 'react', target: '19.3.4', fixer: null }, services),
    ).rejects.toThrow(`${name} declares ">=18 <20"`);
    expect(services.check).not.toHaveBeenCalled();
  }
  const { root, put } = reactFixture();
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  json.dependencies.unrelated = '*';
  put('package.json', JSON.stringify(json));
  await expect(
    rangePreflight(
      { cwd: root, only: 'react', target: '19.3.4' },
      { ...zodFixture(scratch).services, manifests: registry },
    ),
  ).resolves.toBe('19.3.4');
});

it('direct fix rejects complex ranges before the check and branch too', async () => {
  const { root, services } = zodFixture(scratch);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"zod":"latest"}}');
  git(root, 'commit', '-am', 'complex');
  const check = vi.fn(services.check);
  await expect(fix({ cwd: root, only: 'zod' }, { ...services, check })).rejects.toMatchObject({
    code: 'UNSUPPORTED_VERSION_RANGE',
  });
  expect(check).not.toHaveBeenCalled();
});

it('rejects a complex named catalog before cloning, with the catalog field and installed version', async () => {
  const { root, services } = zodFixture(scratch);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"zod":"catalog:shared"}}');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'catalogs:\n  shared:\n    zod: ">=3 <5"\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'catalog');
  const check = vi.fn(services.check);
  await expect(isolatedFix({ cwd: root, only: 'zod' }, { ...services, check })).rejects.toThrow(
    'pnpm-workspace.yaml (catalogs.shared.zod) to "^3.25.76", then rerun.',
  );
  expect(check).not.toHaveBeenCalled();
});

it('reads each committed manifest once during range planning', async () => {
  const { root } = reactFixture();
  const read = vi.fn((file: string) => readFileSync(join(root, file), 'utf8'));
  await rangePreflight({ cwd: root, only: 'react' }, undefined, read);
  expect(read.mock.calls).toEqual([['package.json']]);
});
