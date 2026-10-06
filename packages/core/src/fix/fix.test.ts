import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProgressEvent } from '../domain/progress.js';
import { zodPack } from '../packs/zod/index.js';
import { version } from '../version.js';
import { git } from './process.js';
import { publicationBlockers } from './publish.js';
import { formatFix, prBody, summaryCells } from './report.js';
import { reverify } from './reverify.js';
import { fix } from './run.js';
import { stripeFixture, zodFixture } from './test-fixture.js';
import {
  diagnostics,
  failedTestFiles,
  markPreexisting,
  newDiagnostics,
  planTests,
  testSummary,
  testWorkspaces,
} from './verify.js';
import { bumpCatalog, bumpVersions } from './versions.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-fix-tests-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = () => zodFixture(scratch);
const CLEAN_TOOL = { uptideVersion: version, uptideCommit: 'a'.repeat(40), uptideDirty: false };
describe('fix transaction', () => {
  it('does not pass a run whose baseline cannot see a package the repository installs', async () => {
    const { root, services } = fixture();
    // The repository's own tsc sees zod; a compiler host that does not hides every zod error
    // on both sides, so "0 new errors" would be blind.
    const unseen = {
      file: 'tsconfig.json',
      line: 1,
      column: 1,
      code: 2688,
      message: "Cannot find type definition file for 'zod'.",
    };
    const result = await fix(
      { cwd: root, only: 'zod' },
      { ...services, diagnostics: (r, w) => [unseen, ...services.diagnostics(r, w)] },
    );
    expect(result.verification.newErrors).toHaveLength(0);
    expect(result.verification.typesUnverified).toBe(
      '1 baseline error cannot see zod, which is declared and installed',
    );
    expect(result.verification.passed).toBe(false);
    expect(summaryCells(result).types).toBe('⚠️ not verified (type resolution failed)');
    expect(publicationBlockers(result, { uptideDirty: false })).toContain(
      'verification failed: types not verified (type resolution failed: 1 baseline error cannot see zod, which is declared and installed)',
    );
  });
  it('checks, bumps, commits, fixes only the reported site, and verifies with a real TypeScript program', async () => {
    const { root, services } = fixture();
    const events: ProgressEvent[] = [];
    const result = await fix(
      { cwd: root, only: 'zod', onProgress: (e) => events.push(e) },
      services,
    );
    for (const phase of ['install', 'rules', 'assist', 'verify']) {
      expect(events.some((e) => e.phase === phase && e.state === 'start')).toBe(true);
      expect(events.some((e) => e.phase === phase && e.state === 'done' && (e.ms ?? -1) >= 0)).toBe(
        true,
      );
    }
    expect(result.verification.baseline).toHaveLength(0);
    expect(result.verification.target).toHaveLength(1);
    expect(result.verification.newErrors).toHaveLength(0);
    expect(result.verification.passed).toBe(true);
    expect(result.verification.tests[0]?.status).toBe('missing');
    expect(result.uptideVersion).toBe(version);
    expect(result.uptideCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.uptideCommit).not.toBe(git(root, 'rev-parse', 'HEAD'));
    expect(typeof result.uptideDirty).toBe('boolean');
    expect(result.sites[0]?.outcome).toBe('mechanical');
    expect(result.sites[0]?.rule).toBe('error-params');
    expect(result.sites[0]?.diff).toContain('+ export const schema = z.string({ error:');
    expect(JSON.parse(readFileSync(join(root, '.uptide/report.json'), 'utf8')).head).toBe(
      git(root, 'rev-parse', 'HEAD'),
    );
    expect(git(root, 'branch', '--show-current')).toBe('uptide/zod-4.6.5');
    expect(git(root, 'log', '--oneline', '-2')).toContain('apply mechanical migrations');
    expect(git(root, 'ls-files', '.uptide/pr-body.md')).toBe('');
    expect(readFileSync(result.prBody, 'utf8')).toContain(
      '1 auto-fixed · 0 fixed by the agent (LLM)',
    );
  }, 15000);
  it('refuses dirty trees before running check or installing', async () => {
    const { root, services } = fixture();
    writeFileSync(join(root, 'dirty.txt'), 'x');
    await expect(fix({ cwd: root, only: 'zod' }, services)).rejects.toThrow('clean working tree');
    expect(git(root, 'branch', '--show-current')).not.toBe('uptide/zod-4.6.5');
  });
  it('does not publish when verification fails', async () => {
    const { root, services } = fixture();
    services.diagnostics = () => [
      { file: 'index.ts', line: 1, column: 1, code: 1, message: 'baseline' },
    ];
    let calls = 0;
    services.diagnostics = () =>
      ++calls === 1 ? [] : [{ file: 'index.ts', line: 1, column: 1, code: 1, message: 'new' }];
    // Neither --yes nor --no-llm opens the gate.
    const result = await fix(
      { cwd: root, only: 'zod', pr: true, yes: true, fixer: null, tool: CLEAN_TOOL },
      services,
    );
    expect(result.verification.passed).toBe(false);
    expect(result.prUrl).toBeUndefined();
    expect(result.publication?.refused).toEqual(['verification failed: 1 new type error']);
    expect(result.notes).toContain('PR not opened: verification failed: 1 new type error');
    // The branch exists locally and nothing left the machine: there is not even a remote.
    expect(git(root, 'branch', '--show-current')).toBe('uptide/zod-4.6.5');
    expect(git(root, 'remote')).toBe('');
    const stored = JSON.parse(readFileSync(join(root, '.uptide/report.json'), 'utf8'));
    expect(stored.publication.refused).toEqual(['verification failed: 1 new type error']);
  });
  it('--pr without --yes is a verified run whose plan was printed and nothing pushed', async () => {
    const { root, services } = fixture();
    // The remote is there to resolve; nothing may be pushed to it.
    const origin = join(scratch, `origin-${Date.now()}.git`);
    git(root, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD');
    const result = await fix(
      { cwd: root, only: 'zod', pr: true, fixer: null, tool: CLEAN_TOOL },
      services,
    );
    // `gh` cannot resolve a local bare remote: that is a failed publish step, recorded, and
    // the verified run stands. What matters here is that the --yes gate is not an error.
    if (result.publication?.failed) {
      expect(result.publication.failed).toMatch(/cannot resolve target repository|gh/);
      expect(result.verification.passed).toBe(true);
      expect(git(root, 'ls-remote', '--heads', 'origin', 'uptide/zod-4.6.5')).toBe('');
      return;
    }
    expect(result.verification.passed).toBe(true);
    expect(result.prUrl).toBeUndefined();
    expect(result.publication).toBeUndefined();
    expect(result.notes.join('\n')).toContain(
      'Publication plan printed, nothing pushed (no --yes)',
    );
    expect(git(root, 'ls-remote', '--heads', 'origin', 'uptide/zod-4.6.5')).toBe('');
  });
  it('refuses --pr from an Uptide checkout with uncommitted changes, before any work', async () => {
    const { root, services } = fixture();
    let checked = false;
    const check = services.check;
    services.check = async (options) => {
      checked = true;
      return check(options);
    };
    await expect(
      fix(
        { cwd: root, only: 'zod', pr: true, yes: true, tool: { ...CLEAN_TOOL, uptideDirty: true } },
        services,
      ),
    ).rejects.toThrow(/refuses to run from an Uptide checkout with uncommitted changes/);
    expect(checked).toBe(false);
    expect(git(root, 'branch', '--show-current')).not.toBe('uptide/zod-4.6.5');
    // Without --pr a dirty checkout still works: that is how Uptide itself is developed.
    const local = await fix(
      { cwd: root, only: 'zod', tool: { ...CLEAN_TOOL, uptideDirty: true } },
      services,
    );
    expect(local.uptideDirty).toBe(true);
    expect(local.prUrl).toBeUndefined();
  }, 15000);
});
it('bumps default/named catalogs without replacing catalog references or comments', () => {
  const text =
    'catalog:\n  zod: ^3.0.0 # pinned\ncatalogs:\n  legacy:\n    zod: ^3.2.0\noverrides:\n  zod: ^3.0.0\n';
  const once = bumpCatalog(text, 'zod', '4.6.5', '');
  expect(once).toContain('zod: ^4.6.5 # pinned');
  expect(once).toContain('    zod: ^3.2.0');
  expect(bumpCatalog(once, 'zod', '4.6.5', 'legacy')).toContain('    zod: ^4.6.5');
  expect(() => bumpCatalog(text, 'zod', '4.6.5', 'absent')).toThrow('no entry');
});
it('bumps every declaring workspace, with a shared catalog as the version source', () => {
  const { root } = fixture();
  mkdirSync(join(root, 'packages/app'), { recursive: true });
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\ncatalog:\n  zod: ^3.0.0\n",
  );
  writeFileSync(
    join(root, 'packages/app/package.json'),
    JSON.stringify({ dependencies: { zod: 'catalog:' } }),
  );
  expect(bumpVersions(root, 'zod', '4.6.5').workspaces).toEqual(['.', 'packages/app']);
  expect(readFileSync(join(root, 'packages/app/package.json'), 'utf8')).toContain('catalog:');
  expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('zod: ^4.6.5');
});
it('subtracts baseline as a multiset after lines shift', () => {
  const d = { file: 'a.ts', line: 1, column: 1, code: 123, message: 'bad' };
  expect(
    newDiagnostics(
      [d],
      [
        { ...d, line: 2 },
        { ...d, line: 3 },
      ],
    ),
  ).toEqual([{ ...d, line: 3 }]);
});

it('reports test failures and enforces a timeout for an affected workspace script', async () => {
  const { root } = fixture();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
  );
  expect((await testWorkspaces(root, ['.']))[0]?.status).toBe('failed');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "setInterval(() => {}, 1000)"' } }),
  );
  expect((await testWorkspaces(root, ['.'], 100))[0]?.status).toBe('timeout');
});

it('rejects source changes made by baseline tests before creating a migration branch', async () => {
  const { root, services } = fixture();
  services.tests = async () => {
    writeFileSync(join(root, 'index.ts'), 'changed by tests');
    return [{ workspace: '.', status: 'passed', output: '' }];
  };
  await expect(fix({ cwd: root, only: 'zod' }, services)).rejects.toThrow(
    'baseline tests modified',
  );
  expect(git(root, 'branch', '--show-current')).not.toBe('uptide/zod-4.6.5');
});

it('checks workspace source under its own resolution mode, not the importer bundler mode', () => {
  const { root } = fixture();
  for (const name of ['app', 'shared']) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, 'shared/tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'node', skipLibCheck: true },
      include: ['index.ts'],
    }),
  );
  writeFileSync(
    join(root, 'app/tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true },
      include: ['index.ts'],
    }),
  );
  for (const name of ['app', 'shared']) writeFileSync(join(root, name, 'package.json'), '{}');
  mkdirSync(join(root, 'node_modules/hidden'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/hidden/package.json'),
    JSON.stringify({ name: 'hidden', exports: { '.': './index.d.ts' } }),
  );
  writeFileSync(join(root, 'node_modules/hidden/private.d.ts'), 'export type Value = string;');
  writeFileSync(
    join(root, 'shared/index.ts'),
    "import type {Value} from 'hidden/private.js'; export const value: Value = 'ok';",
  );
  writeFileSync(
    join(root, 'app/index.ts'),
    "import {value} from '../shared/index.js'; export const result: string = value;",
  );
  expect(diagnostics(root, ['app', 'shared'])).toEqual([]);
  writeFileSync(
    join(root, 'shared/index.ts'),
    "import type {Value} from 'hidden/private.js'; export const value: Value = 42;",
  );
  expect(diagnostics(root, ['app', 'shared']).map((d) => [d.file, d.code])).toEqual([
    ['shared/index.ts', 2322],
  ]);
});

it('reports deliberately disabled assistance without claiming the API key is missing', async () => {
  const { root, services } = fixture();
  const result = await fix({ cwd: root, only: 'zod', fixer: null }, services);
  expect(result.llm).toMatchObject({ available: false, disabled: true });
  expect(formatFix(result)).toContain('disabled (--no-llm)');
  expect(formatFix(result)).not.toContain('no API key');
  expect(result.prBody).not.toContain('no ANTHROPIC_API_KEY');
});

it('applies a pack follow-up as its own commit and site, and scopes the tests to it too', async () => {
  const { root, services } = fixture();
  writeFileSync(join(root, 'index.test.ts'), "expect(label).toBe('old');\n");
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'a test asserting a value the migration changes');
  const scoped: string[][] = [];
  services.tests = async (_root, _workspaces, _timeout, files) => {
    scoped.push([...(files ?? [])]);
    return [];
  };
  const result = await fix(
    {
      cwd: root,
      only: 'zod',
      pack: {
        ...zodPack,
        followUps: ({ finding }) =>
          finding.usage.file === 'index.ts'
            ? [
                {
                  file: 'index.test.ts',
                  line: 1,
                  before: "expect(label).toBe('old');",
                  after: "expect(label).toBe('new');",
                  reason: 'the assertion follows the constant',
                },
              ]
            : [],
      },
    },
    services,
  );
  expect(readFileSync(join(root, 'index.test.ts'), 'utf8')).toBe("expect(label).toBe('new');\n");
  expect(git(root, 'log', '-1', '--format=%s')).toBe(
    'fix(zod): follow index.ts:2 in index.test.ts',
  );
  expect(result.sites.map((s) => [s.finding.usage.file, s.outcome, s.rule, s.reason])).toEqual([
    ['index.ts', 'mechanical', 'error-params', expect.any(String)],
    ['index.test.ts', 'mechanical', 'error-params', 'the assertion follows the constant'],
  ]);
  expect(result.sites[1]?.diff).toBe("- expect(label).toBe('old');\n+ expect(label).toBe('new');");
  // Baseline is scoped to the reported file; the target run knows the follow-up as well.
  expect(scoped).toEqual([['index.ts'], ['index.ts', 'index.test.ts']]);
  expect(result.verification.passed).toBe(true);
}, 15000);

it('lets the pack fix a test the migration made fail, then lets the tests judge the edit', async () => {
  const { root, services } = fixture();
  writeFileSync(join(root, 'index.test.ts'), 'expect(message).toContain("Required");\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'a test that depends on a default message');
  // Baseline passes; the first target run fails on the test; the run after the follow-up passes.
  const outcomes = ['passed', 'failed', 'passed'] as const;
  let runs = 0;
  services.tests = async () => {
    const status = outcomes[runs++] ?? 'passed';
    return [
      {
        workspace: '.',
        status,
        output: status === 'failed' ? ' FAIL  unit  index.test.ts > reads the message\n' : '',
      },
    ];
  };
  const asked: string[][] = [];
  const result = await fix(
    {
      cwd: root,
      only: 'zod',
      pack: {
        ...zodPack,
        scanContext: () => ({}),
        testFollowUps: ({ failing }) => {
          asked.push(failing);
          return [
            {
              file: 'index.test.ts',
              line: 1,
              before: 'expect(message).toContain("Required");',
              after: 'expect(message).toContain("received undefined");',
              reason: 'the assertion follows the new default message',
            },
          ];
        },
        decisions: (_context, _rules, followed) =>
          (followed ?? []).map((f) => `- ${f.rule} ${f.file}:${f.line}`),
      },
    },
    services,
  );
  expect(asked).toEqual([['index.test.ts']]);
  expect(runs).toBe(3);
  expect(readFileSync(join(root, 'index.test.ts'), 'utf8')).toContain('received undefined');
  expect(git(root, 'log', '-1', '--format=%s')).toBe(
    'fix(zod): follow the failing tests in index.test.ts',
  );
  expect(result.sites.at(-1)).toMatchObject({
    outcome: 'mechanical',
    rule: 'default-messages',
    reason: 'the assertion follows the new default message',
  });
  expect(result.decisions).toEqual(['- default-messages index.test.ts:1']);
  expect(result.verification.passed).toBe(true);
  const body = readFileSync(result.prBody, 'utf8');
  expect(body).toContain('Default error messages');
  expect(body).toContain('### Decisions for you\n\n- default-messages index.test.ts:1');
}, 15000);

it('does not ask the pack when the tests pass, and a failed follow-up run still fails', async () => {
  const { root, services } = fixture();
  let asked = 0;
  const pack = {
    ...zodPack,
    scanContext: () => ({}),
    testFollowUps: () => {
      asked++;
      return [];
    },
  };
  services.tests = async () => [{ workspace: '.', status: 'passed' as const, output: '' }];
  await fix({ cwd: root, only: 'zod', pack }, services);
  expect(asked).toBe(0);
  const second = fixture();
  let runs = 0;
  second.services.tests = async () => [
    {
      workspace: '.',
      status: runs++ === 0 ? ('passed' as const) : ('failed' as const),
      output: '',
    },
  ];
  const failed = await fix({ cwd: second.root, only: 'zod', pack }, second.services);
  expect(asked).toBe(1);
  expect(failed.verification.passed).toBe(false);
}, 20000);

describe('the repository formatter and lint', () => {
  it('formats only the edited files in their own commit, and records a clean lint', async () => {
    const { root, services } = fixture();
    const formattedWith: string[][] = [];
    services.format = async (dir, files) => {
      formattedWith.push([...files]);
      for (const file of files)
        writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}// formatted\n`);
      return ['biome'];
    };
    services.lint = async (_dir, files) => [
      {
        tool: 'biome',
        status: 'passed',
        command: `biome check ${files.join(' ')}`,
        files: files.length,
        output: '',
      },
    ];
    const result = await fix({ cwd: root, only: 'zod' }, services);
    expect(formattedWith).toEqual([['index.ts']]);
    expect(git(root, 'log', '-1', '--format=%s')).toBe(
      'style(zod): format the files the migration edited',
    );
    expect(git(root, 'show', '--stat', '--format=', 'HEAD').split('\n')[0]).toContain('index.ts');
    expect(result.verification.formatted).toEqual(['biome']);
    expect(result.verification.lint?.[0]?.status).toBe('passed');
    expect(result.verification.passed).toBe(true);
    const body = readFileSync(result.prBody, 'utf8');
    expect(body).toMatch(/\| \*\*Tests\*\* \| .* · lint clean \(biome\) \|/);
    expect(body).toContain(
      'Formatted with biome: only the files this migration edited, in their own commit.',
    );
  }, 15000);

  it('formats after every round of edits but commits the formatting once, at the end', async () => {
    const { root, services } = fixture();
    writeFileSync(join(root, 'index.test.ts'), "export const expected = 'old';\n");
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'a test');
    let rounds = 0;
    services.format = async (dir, files) => {
      rounds++;
      for (const file of files)
        writeFileSync(
          join(dir, file),
          `${readFileSync(join(dir, file), 'utf8')}// formatted ${rounds}\n`,
        );
      return ['prettier'];
    };
    services.lint = async () => [];
    let runs = 0;
    services.tests = async () => [
      {
        workspace: '.',
        status: runs++ === 1 ? 'failed' : 'passed',
        output: ' FAIL  index.test.ts > x\n',
      },
    ];
    // A pack whose test follow-up edits the failing test: a second round of edits and format.
    const pack = {
      ...zodPack,
      testFollowUps: () => [
        {
          file: 'index.test.ts',
          line: 1,
          before: "export const expected = 'old';",
          after: "export const expected = 'new';",
          reason: 'the test follows the migration',
        },
      ],
    };
    const result = await fix({ cwd: root, only: 'zod', pack }, services);
    expect(rounds).toBe(2);
    const subjects = git(root, 'log', '--format=%s').split('\n');
    expect(subjects.filter((s) => s.startsWith('style('))).toEqual([
      'style(zod): format the files the migration edited',
    ]);
    expect(subjects[0]).toBe('style(zod): format the files the migration edited');
    expect(git(root, 'status', '--porcelain')).not.toContain('index');
    expect(result.verification.formatted).toEqual(['prettier']);
  }, 20000);

  it('fails verification on a lint failure the migration introduced, and refuses to publish', async () => {
    const { root, services } = fixture();
    let calls = 0;
    // The baseline lint passes; after the migration the same files fail.
    services.lint = async () => [
      {
        tool: 'biome',
        status: calls++ === 0 ? 'passed' : 'failed',
        command: 'biome check index.ts',
        files: 1,
        output: 'index.ts:2 format',
      },
    ];
    const result = await fix(
      { cwd: root, only: 'zod', pr: true, yes: true, tool: CLEAN_TOOL },
      services,
    );
    expect(result.verification.newErrors).toEqual([]);
    expect(result.verification.passed).toBe(false);
    expect(result.publication?.refused).toEqual([
      'verification failed: lint (biome) fails on the edited files',
    ]);
    const body = readFileSync(result.prBody, 'utf8');
    expect(body).toContain('· ❌ lint fails (biome) |');
    expect(body).toContain("The repository's lint (biome) fails on the edited files");
  }, 15000);

  it('does not fail on lint that already failed before the migration', async () => {
    const { root, services } = fixture();
    services.lint = async (_dir, _files, baseline) => [
      {
        tool: 'biome',
        status: baseline === undefined ? 'failed' : 'pre-existing',
        command: 'biome check index.ts',
        files: 1,
        output: 'old',
      },
    ];
    const result = await fix({ cwd: root, only: 'zod' }, services);
    expect(result.verification.passed).toBe(true);
    expect(readFileSync(result.prBody, 'utf8')).toContain('lint was already failing (biome)');
  }, 15000);
});

describe('verifying a migration branch again', () => {
  it('adds commits on top, never rewrites, and records the new HEAD', async () => {
    const { root, services } = fixture();
    const first = await fix({ cwd: root, only: 'zod', tool: CLEAN_TOOL }, services);
    const before = git(root, 'log', '--format=%H');
    // Later the repository gains a formatter: the stored run predates it.
    const again = await reverify(
      { cwd: root, tool: CLEAN_TOOL },
      {
        diagnostics,
        tests: async () => [{ workspace: '.', status: 'passed', output: '' }],
        format: async (dir, files) => {
          for (const file of files)
            writeFileSync(
              join(dir, file),
              `${readFileSync(join(dir, file), 'utf8')}// formatted\n`,
            );
          return ['biome'];
        },
        lint: async (_dir, files) => [
          {
            tool: 'biome',
            status: 'passed',
            command: 'biome check',
            files: files.length,
            output: '',
          },
        ],
      },
    );
    const after = git(root, 'log', '--format=%H');
    // Every earlier commit is still there, in place, under exactly one new commit.
    expect(after.endsWith(before)).toBe(true);
    expect(after.split('\n')).toHaveLength(before.split('\n').length + 1);
    expect(git(root, 'log', '-1', '--format=%s')).toBe(
      'style(zod): format the files the migration edited',
    );
    expect(again.head).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(again.head).not.toBe(first.head);
    expect(again.verification.passed).toBe(true);
    expect(again.verification.baseline).toEqual(first.verification.baseline);
    expect(again.notes.at(-1)).toMatch(
      /^Verified again at a new HEAD: 0 follow-up edits and formatting/,
    );
    const stored = JSON.parse(readFileSync(join(root, '.uptide/report.json'), 'utf8'));
    expect(stored.head).toBe(again.head);
    // Running it again with nothing left to do adds nothing.
    const third = await reverify(
      { cwd: root, tool: CLEAN_TOOL },
      { diagnostics, tests: async () => [], format: async () => [], lint: async () => [] },
    );
    expect(third.head).toBe(again.head);
  }, 20000);

  it('refuses another branch, uncommitted changes, or a missing run', async () => {
    const { root, services } = fixture();
    await expect(reverify({ cwd: root })).rejects.toThrow('no stored migration run');
    await fix({ cwd: root, only: 'zod', tool: CLEAN_TOOL }, services);
    writeFileSync(join(root, 'index.ts'), 'export {};\n');
    await expect(reverify({ cwd: root })).rejects.toThrow('clean working tree');
    git(root, 'checkout', '--', 'index.ts');
    git(root, 'switch', '-c', 'other');
    await expect(reverify({ cwd: root })).rejects.toThrow('check out uptide/zod-4.6.5 first');
  }, 20000);

  it('fails when the new HEAD has a type error the baseline did not', async () => {
    const { root, services } = fixture();
    await fix({ cwd: root, only: 'zod', tool: CLEAN_TOOL }, services);
    const failed = await reverify(
      { cwd: root, tool: CLEAN_TOOL },
      {
        diagnostics: () => [{ file: 'index.ts', line: 1, column: 1, code: 2322, message: 'new' }],
        tests: async () => [],
        format: async () => [],
        lint: async () => [],
      },
    );
    expect(failed.verification.passed).toBe(false);
    expect(failed.verification.newErrors).toHaveLength(1);
  }, 20000);
});

describe('test detection', () => {
  /** A monorepo with a root runner configuration: no workspace has a test script. */
  function monorepo(runner: 'vitest' | 'jest', rootScripts: Record<string, string> = {}) {
    const root = mkdtempSync(join(scratch, 'tests-'));
    const write = (file: string, text: string, mode?: number) => {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text, mode ? { mode } : {});
    };
    write('package.json', JSON.stringify({ name: 'mono', scripts: rootScripts }));
    write(`${runner}.config.ts`, 'export default {};');
    // A stand-in runner: it prints what it was asked to run, in the real runner's summary format.
    write(
      `node_modules/.bin/${runner}`,
      `#!/bin/sh\necho "ARGS $*"\necho " Test Files  2 passed (2)"\necho "      Tests  7 passed (7)"\n`,
      0o755,
    );
    for (const name of ['api', 'shared']) {
      write(`packages/${name}/package.json`, JSON.stringify({ name, scripts: { build: 'tsc' } }));
      write(`packages/${name}/src/a.ts`, 'export const a = 1;');
    }
    return root;
  }

  it('uses the root vitest configuration for workspaces without a test script, scoped to the affected files', async () => {
    const root = monorepo('vitest');
    const workspaces = ['packages/api', 'packages/shared'];
    const files = ['packages/api/src/a.ts', 'packages/shared/src/a.ts', 'packages/api/src/gone.ts'];
    expect(planTests(root, workspaces, files)).toEqual([
      {
        workspace: '.',
        covers: workspaces,
        cwd: root,
        command:
          'vitest related --run --passWithNoTests packages/api/src/a.ts packages/shared/src/a.ts',
        scope: 'vitest tests related to 2 affected files, vitest.config.ts',
      },
    ]);
    const [result] = await testWorkspaces(root, workspaces, 10_000, files);
    expect(result).toMatchObject({
      workspace: '.',
      status: 'passed',
      covers: workspaces,
      summary: '7 tests in 2 files',
      scope: 'vitest tests related to 2 affected files, vitest.config.ts',
    });
    expect(result?.output).toContain(
      'ARGS related --run --passWithNoTests packages/api/src/a.ts packages/shared/src/a.ts',
    );
  });

  it('runs the repository pretest first when its test script is the same runner', async () => {
    const root = monorepo('vitest', { pretest: 'echo BUILT', test: 'vitest run' });
    const [plan] = planTests(root, ['packages/api'], ['packages/api/src/a.ts']);
    expect(plan).toMatchObject({
      command: 'echo BUILT && vitest related --run --passWithNoTests packages/api/src/a.ts',
      scope: 'vitest tests related to 1 affected file, vitest.config.ts after `pretest`',
    });
    const [result] = await testWorkspaces(root, ['packages/api'], 10_000, [
      'packages/api/src/a.ts',
    ]);
    expect(result?.output).toMatch(/BUILT[\s\S]*ARGS related/);
    // A failing pretest fails the run: the tests never had what they import.
    const broken = monorepo('vitest', { pretest: 'exit 1', test: 'vitest run' });
    const [failed] = await testWorkspaces(broken, ['packages/api'], 10_000, [
      'packages/api/src/a.ts',
    ]);
    expect(failed?.status).toBe('failed');
    // A pretest of some other test script is not ours to run.
    const other = monorepo('vitest', { pretest: 'echo BUILT', test: 'node --test' });
    expect(planTests(other, ['packages/api'])[0]?.command).toBe(
      'vitest run --passWithNoTests packages/api',
    );
  });

  it('plans baseline and target identically, and falls back to the workspace directories without files', () => {
    const root = monorepo('vitest');
    const workspaces = ['packages/api'];
    expect(planTests(root, workspaces, ['packages/api/src/a.ts'])).toEqual(
      planTests(root, workspaces, ['packages/api/src/a.ts']),
    );
    expect(planTests(root, workspaces)[0]).toMatchObject({
      command: 'vitest run --passWithNoTests packages/api',
      scope: 'vitest tests under packages/api, vitest.config.ts',
    });
  });

  it('knows jest, prefers a workspace script, then the root script, and says when nothing covers a workspace', () => {
    const jest = monorepo('jest');
    expect(planTests(jest, ['packages/api'], ['packages/api/src/a.ts'])[0]).toMatchObject({
      command: 'jest --findRelatedTests --passWithNoTests packages/api/src/a.ts',
      scope: 'jest tests related to 1 affected file, jest.config.ts',
    });
    writeFileSync(
      join(jest, 'packages/api/package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
    );
    expect(
      planTests(jest, ['packages/api', 'packages/shared']).map((p) => [p.workspace, p.command]),
    ).toEqual([
      ['packages/api', 'node --test'],
      ['.', 'jest --passWithNoTests packages/shared'],
    ]);
    // No runner configuration anywhere: the root script answers; without one, nothing does.
    const bare = mkdtempSync(join(scratch, 'bare-'));
    mkdirSync(join(bare, 'packages/api'), { recursive: true });
    writeFileSync(join(bare, 'packages/api/package.json'), '{}');
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(planTests(bare, ['packages/api'])[0]).toMatchObject({
      workspace: '.',
      covers: ['packages/api'],
      command: 'node --test',
    });
    writeFileSync(join(bare, 'package.json'), '{}');
    expect(planTests(bare, ['packages/api'])[0]).toMatchObject({
      command: '',
      scope: 'no test script, and no vitest or jest configuration covers this workspace',
    });
  });

  it('reads the counts both runners print, and reports "no related tests" as no tests', async () => {
    expect(testSummary(' Test Files  41 passed (41)\n      Tests  270 passed (270)\n')).toBe(
      '270 tests in 41 files',
    );
    expect(
      testSummary('Tests:       1 failed, 5 passed, 6 total\nTest Suites: 1 passed, 1 total'),
    ).toBe('5 tests in 1 file');
    expect(testSummary('ok')).toBeUndefined();
    const root = monorepo('vitest');
    writeFileSync(
      join(root, 'node_modules/.bin/vitest'),
      '#!/bin/sh\necho "No test files found, exiting with code 0"\n',
      { mode: 0o755 },
    );
    const [result] = await testWorkspaces(root, ['packages/api'], 10_000, [
      'packages/api/src/a.ts',
    ]);
    expect(result?.status).toBe('missing');
    expect(result?.output).toMatch(/^no tests are related to the affected files \(vitest related/);
  });
});

describe('a failure outside the affected files', () => {
  /** A repository whose test script fails the first time it runs and passes afterwards. */
  function flaky(failingFile: string, alwaysFail = false) {
    const root = mkdtempSync(join(scratch, 'flaky-'));
    const marker = join(scratch, `ran-${Math.random().toString(36).slice(2)}`);
    const script = alwaysFail
      ? `echo " FAIL  api:e2e  ${failingFile} > resets"; exit 1`
      : `if [ -f ${marker} ]; then echo "      Tests  3 passed (3)"; else touch ${marker}; echo " FAIL  api:e2e  ${failingFile} > resets"; echo "Error: read ECONNRESET"; exit 1; fi`;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    return root;
  }
  const affected = ['src/billing/container.ts'];

  it('is run once more, and a pass is recorded as a rerun', async () => {
    const root = flaky('src/routes/customerSessionRoutes.e2e.test.ts');
    const [result] = await testWorkspaces(root, ['.'], 10_000, affected);
    expect(result).toMatchObject({
      status: 'passed',
      summary: '3 tests',
      retried: ['src/routes/customerSessionRoutes.e2e.test.ts'],
    });
  });

  it('still fails when the rerun fails too', async () => {
    const root = flaky('src/routes/customerSessionRoutes.e2e.test.ts', true);
    const [result] = await testWorkspaces(root, ['.'], 10_000, affected);
    expect(result?.status).toBe('failed');
    expect(result?.retried).toBeUndefined();
  });

  it('never retries a failing test of an affected file into a pass', async () => {
    // It would pass the second time, but it is the test of the file the migration changed.
    const root = flaky('src/billing/container.test.ts');
    const [result] = await testWorkspaces(root, ['.'], 10_000, affected);
    expect(result?.status).toBe('failed');
    expect(failedTestFiles(result?.output ?? '')).toEqual(['src/billing/container.test.ts']);
  });
});

it("stores test output as plain text without this machine's paths", async () => {
  const root = mkdtempSync(join(scratch, 'plain-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: `printf '\\033[32mok\\033[39m ${root}/src/a.test.ts\\n'` } }),
  );
  const [result] = await testWorkspaces(root, ['.'], 10_000);
  expect(result?.output).toBe('ok <repo>/src/a.test.ts\n');
});

describe('fix --pin-current-api', () => {
  it('keeps the SDK, writes its default apiVersion on every unpinned client, verifies, and writes the small PR', async () => {
    const { root, services } = stripeFixture(scratch);
    const events: ProgressEvent[] = [];
    const result = await fix(
      {
        cwd: root,
        only: 'stripe',
        pinCurrentApi: true,
        onProgress: (e) => events.push(e),
        tool: CLEAN_TOOL,
      },
      services,
    );
    expect(result).toMatchObject({
      mode: 'pin',
      apiVersion: '2023-10-16',
      from: '14.25.0',
      target: '14.25.0',
      branch: 'uptide/stripe-pin-2023-10-16',
      llm: { disabled: true, costUsd: 0 },
    });
    expect(result.verification.passed).toBe(true);
    expect(result.verification.newErrors).toEqual([]);
    expect(
      result.sites.map(
        (s) => `${s.finding.usage.file}:${s.finding.usage.line} ${s.rule} ${s.outcome}`,
      ),
    ).toEqual([
      'src/billing.ts:5 api-version-pin mechanical',
      'src/billing.ts:3 api-version-pin mechanical',
    ]);
    expect(readFileSync(join(root, 'src/billing.ts'), 'utf8')).toBe(
      [
        "import Stripe from 'stripe';",
        '',
        "export const stripe = new Stripe(process.env.STRIPE_KEY ?? '', { apiVersion: '2023-10-16' });",
        "export const pinned = new Stripe('sk', { apiVersion: '2023-10-16' });",
        "export const retried = new Stripe('sk', {",
        "  apiVersion: '2023-10-16',",
        '  maxNetworkRetries: 2,',
        '});',
        '',
      ].join('\n'),
    );
    expect(git(root, 'branch', '--show-current')).toBe('uptide/stripe-pin-2023-10-16');
    expect(git(root, 'log', '--oneline', '-1')).toContain('pin the API version to 2023-10-16');
    expect(events.some((e) => e.phase === 'install')).toBe(false);
    const body = prBody(result);
    expect(body).toContain('## Pin the Stripe API version to 2023-10-16');
    expect(body).toContain('**Ready for review.** stripe stays at 14.25.0');
    expect(body).toContain(
      '| **Risk** | Low: no behaviour change: the explicit pin equals the SDK default |',
    );
    expect(body).toContain('**1. Stripe API version pinned** · 2 sites · auto-fixed');
    expect(body).not.toContain('Upgrade stripe');
    expect(formatFix(result)).toContain('Pin the Stripe API version to 2023-10-16');
  });

  it('refuses a package other than stripe', async () => {
    const { root, services } = zodFixture(scratch);
    await expect(fix({ cwd: root, only: 'zod', pinCurrentApi: true }, services)).rejects.toThrow(
      'stripe only',
    );
  });
});

it('marks a failure the baseline already had, by file, and keeps a new failing file as a failure', () => {
  const run = (workspace: string, status: 'passed' | 'failed', output: string) => ({
    workspace,
    status,
    output,
  });
  const marked = markPreexisting(
    [
      run('core', 'failed', ' FAIL  src/a.test.ts > x\n FAIL  src/b.test.ts > y\n'),
      run('worker', 'failed', ' FAIL  src/a.test.ts > x\n FAIL  src/new.test.ts > z\n'),
      run('ui', 'failed', 'Error: boom\n'),
      run('api', 'passed', ''),
    ],
    [
      run(
        'core',
        'failed',
        ' FAIL  src/a.test.ts > x\n FAIL  src/b.test.ts > y\n FAIL  src/c.test.ts\n',
      ),
      run('worker', 'failed', ' FAIL  src/a.test.ts > x\n'),
      run('ui', 'failed', 'Error: boom\n'),
      run('api', 'passed', ''),
    ],
  );
  expect(marked.map((t) => t.preexisting)).toEqual([
    ['src/a.test.ts', 'src/b.test.ts'],
    undefined,
    ['*'],
    undefined,
  ]);
});

it('says what a TS2322 expected, as a shape, so the migration knows the new form', () => {
  const root = mkdtempSync(join(scratch, 'expected-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"name":"expected"}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src'],
    }),
  );
  writeFileSync(
    join(root, 'src/anchor.ts'),
    [
      'type OtherString = string & Record<never, never>;',
      'interface Anchor { type: "now" | "unchanged" | OtherString; at?: number }',
      'interface Params { billing_cycle_anchor?: Anchor; label: string }',
      'export function update(p: Params): Params { return p; }',
      'update({ billing_cycle_anchor: "now", label: "x" });',
      'update({ billing_cycle_anchor: { type: "now" }, label: 3 });',
      '',
    ].join('\n'),
  );
  const found = diagnostics(root, ['.']).map((d) => `${d.line} TS${d.code} ${d.expected ?? '-'}`);
  expect(found).toEqual([
    '5 TS2322 Anchor: { type: OtherString | "now" | "unchanged"; at?: number }',
    // A primitive expected type is already all the message says.
    '6 TS2322 -',
  ]);
});
