import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listDependencies } from './list.js';
import { createDiscoveryFetcher } from './registry.js';

const base = fileURLToPath(new URL('../../../../fixtures/repos/list-accuracy/', import.meta.url));
const roots: string[] = [];
const cases = JSON.parse(readFileSync(join(base, 'rc-configs/cases.json'), 'utf8')) as {
  file: string;
  tool: string;
  content: string;
}[];
function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'uptide-tool-config-'));
  roots.push(root);
  cpSync(join(base, name), root, { recursive: true });
  if (existsSync(join(root, 'installed.json')))
    for (const [name, metadata] of Object.entries(
      JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8')),
    )) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', ...(metadata as object) }),
      );
    }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fetcher = { resolve: async () => '2.0.0', metadata: async () => ({}) };
it.each(cases)(
  '$file alone proves $tool is used, without executing the configuration',
  async ({ file, tool, content }) => {
    const cwd = fixture('rc-configs');
    writeFileSync(join(cwd, file), content);
    const report = await listDependencies({ cwd, fetcher });
    expect(report.failures).toEqual([]);
    expect(report.packages.find((p) => p.name === tool)).toMatchObject({
      classification: 'tooling',
      reasons: expect.arrayContaining([`config file ${file}`]),
    });
    expect(report.packages.find((p) => p.name === 'orphan')?.classification).toBe(
      'possibly-unused',
    );
  },
);
it('reads YAML task values, hook strings, and credits both colliding webpack bins', async () => {
  const report = await listDependencies({ cwd: fixture('angular-hooks'), fetcher });
  expect(report.failures).toEqual([]);
  expect(report.packages.filter((p) => p.classification === 'tooling')).toHaveLength(7);
  expect(
    report.packages.filter((p) => p.classification === 'possibly-unused').map((p) => p.name),
  ).toEqual(['orphan']);
  for (const name of ['pretty-quick', 'standard', 'webpack', 'webpack-cli'])
    expect(report.packages.find((p) => p.name === name)?.reasons).toContain('lint-staged command');
  expect(report.packages.find((p) => p.name === 'lint-staged')?.reasons).toContain(
    'hook/task command in .huskyrc',
  );
  expect(report.packages.find((p) => p.name === 'prettier')?.reasons).toContain(
    'config file .prettierrc',
  );
});
it.each([
  '.huskyrc.json',
  '.huskyrc.js',
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.js',
  '.lintstagedrc.yaml',
  'lint-staged.config.cjs',
  '.simple-git-hooks.json',
  'simple-git-hooks.js',
])('reads command bins from %s', async (file) => {
  const cwd = fixture('task-fields');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'task-app', dependencies: { 'hook-worker': '1.0.0', orphan: '1.0.0' } }),
  );
  const value = file.includes('husky')
    ? { hooks: { 'pre-commit': 'check-hooks --all' } }
    : file.includes('simple-git-hooks')
      ? { 'pre-commit': 'check-hooks --all' }
      : { '*.js': ['check-hooks --all'] };
  writeFileSync(
    join(cwd, file),
    file.endsWith('.yaml')
      ? "'*.js':\n  - check-hooks --all\n"
      : /\.[cm]?js$/.test(file)
        ? `throw new Error('do not execute'); module.exports = ${JSON.stringify(value)};`
        : JSON.stringify(value),
  );
  const report = await listDependencies({ cwd, fetcher });
  expect(report.packages.find((p) => p.name === 'hook-worker')).toMatchObject({
    classification: 'tooling',
    reasons: expect.arrayContaining([
      file.includes('lint') ? 'lint-staged command' : `hook/task command in ${file}`,
    ]),
  });
});
it('recognizes generic manifest configuration fields and hook/task commands by installed bins', async () => {
  const report = await listDependencies({ cwd: fixture('task-fields'), fetcher });
  for (const name of ['standard', 'ava', 'xo', 'custom-tool'])
    expect(report.packages.find((p) => p.name === name)?.reasons).toContain(
      `package.json field: ${name}`,
    );
  expect(report.packages.find((p) => p.name === 'pretty-quick')?.reasons).toContain(
    'hook/task command in package.json husky.hooks',
  );
  expect(report.packages.find((p) => p.name === 'standard')?.reasons).toContain(
    'lint-staged command',
  );
  expect(report.packages.find((p) => p.name === 'hook-worker')?.reasons).toContain(
    'hook/task command in package.json simple-git-hooks',
  );
  expect(
    report.packages.filter((p) => p.classification === 'possibly-unused').map((p) => p.name),
  ).toEqual(['orphan']);
});
it('resolves Karma short names, default plugins, runtime requirements and peer requirements (not devDependencies)', async () => {
  const report = await listDependencies({ cwd: fixture('angular-karma'), fetcher });
  expect(report.failures).toEqual([]);
  expect(
    report.packages.filter((p) => p.classification === 'possibly-unused').map((p) => p.name),
  ).toEqual(['dev-only-helper', 'orphan']);
  expect(report.packages.find((p) => p.name === 'jasmine-core')?.reasons).toEqual(
    expect.arrayContaining(['Karma frameworks: jasmine', 'required by karma-jasmine']),
  );
  expect(report.packages.find((p) => p.name === 'direct-helper')?.reasons).toContain(
    'required by karma-jasmine',
  );
  expect(report.packages.find((p) => p.name === 'peer-helper')?.reasons).toContain(
    'required by karma-jasmine',
  );
  expect(report.packages.find((p) => p.name === 'karma-extra')?.reasons).toContain(
    'auto-loaded by Karma (plugins unset)',
  );
});
it.each([
  ['frameworks', "['jasmine']", ['karma-jasmine', 'jasmine-core']],
  ['frameworks', "['webpack']", ['karma-webpack']],
  ['reporters', "['coverage','spec']", ['karma-coverage', 'karma-spec-reporter']],
  ['browsers', "['Chrome','ChromeHeadless']", ['karma-chrome-launcher']],
  ['preprocessors', "{'**/*.js':['sourcemap']}", ['karma-sourcemap-loader']],
  ['plugins', "['karma-extra']", ['karma-extra']],
] as const)(
  'maps explicit Karma %s without auto-loading other plugins',
  async (field, value, expected) => {
    const cwd = fixture('angular-karma');
    writeFileSync(
      join(cwd, 'karma.conf.js'),
      `module.exports = config => config.set({${field === 'plugins' ? '' : 'plugins: [],'}${field}: ${value}});`,
    );
    const report = await listDependencies({ cwd, fetcher });
    for (const name of expected)
      expect(report.packages.find((p) => p.name === name)?.classification).toBe('tooling');
    if (field !== 'plugins')
      expect(report.packages.find((p) => p.name === 'karma-extra')?.classification).toBe(
        'possibly-unused',
      );
  },
);
it('retains runtime dependencies in abbreviated registry metadata', async () => {
  const cwd = fixture('angular-karma');
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
  writeFileSync(
    join(cwd, 'karma.conf.js'),
    "module.exports = config => config.set({plugins: ['karma-jasmine']});",
  );
  const metadata = JSON.parse(readFileSync(join(cwd, 'installed.json'), 'utf8'));
  const registry = createDiscoveryFetcher({
    cwd,
    config: { registry: 'https://registry.invalid', scoped: {}, tokens: {} },
    fetch: async (input) => {
      const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
      return Response.json({
        'dist-tags': { latest: '2.0.0' },
        versions: { '1.0.0': metadata[name] ?? {}, '2.0.0': {} },
      });
    },
  });
  const report = await listDependencies({ cwd, fetcher: registry });
  expect(report.packages.find((p) => p.name === 'jasmine-core')?.reasons).toContain(
    'required by karma-jasmine',
  );
  expect(report.packages.find((p) => p.name === 'dev-only-helper')?.classification).toBe(
    'possibly-unused',
  );
});
it('ignores YAML comments, negative lookalikes, and unrelated dev-only dependency metadata', async () => {
  const cwd = fixture('angular-hooks');
  writeFileSync(
    join(cwd, '.lintstagedrc.yaml'),
    "# orphan\n'*.js':\n  - standard-extra --fix # orphan\n",
  );
  const report = await listDependencies({ cwd, fetcher });
  expect(report.packages.find((p) => p.name === 'standard')?.classification).toBe(
    'possibly-unused',
  );
  expect(report.packages.find((p) => p.name === 'orphan')?.classification).toBe('possibly-unused');
});
it('reports timings/file counts only when requested, counting configs separately from sources and ignoring node_modules', async () => {
  const cwd = fixture('angular-hooks');
  writeFileSync(join(cwd, 'app.js'), "import something from 'orphan'; something();");
  writeFileSync(join(cwd, 'app.scss'), '@use "theme";');
  writeFileSync(join(cwd, 'readme.txt'), 'not scanned as code');
  const report = await listDependencies({ cwd, fetcher, verbose: true });
  expect(report.timing.files).toMatchObject({
    manifests: 1,
    installedManifests: 6,
    visited: 8,
    source: 1,
    config: 3,
    assets: 1,
  });
  expect(Object.keys(report.timing.phases ?? {})).toEqual([
    'manifestReadMs',
    'registryMs',
    'sourceScanMs',
    'configScanMs',
  ]);
  expect(Object.values(report.timing.phases ?? {}).every((ms) => ms >= 0)).toBe(true);
  const normal = await listDependencies({ cwd, fetcher });
  expect(normal.timing).not.toHaveProperty('phases');
  expect(normal.timing).not.toHaveProperty('files');
});

it('retains JSON-with-comments configuration references without crediting comments', async () => {
  const cwd = fixture('angular-hooks');
  writeFileSync(join(cwd, 'tsconfig.json'), '{\n// "pretty-quick"\n"extends": "orphan"\n}');
  rmSync(join(cwd, '.lintstagedrc.yaml'));
  const report = await listDependencies({ cwd, fetcher });
  expect(report.packages.find((p) => p.name === 'orphan')?.reasons).toContain(
    'referenced by configuration',
  );
  expect(report.packages.find((p) => p.name === 'pretty-quick')?.classification).toBe(
    'possibly-unused',
  );
});
