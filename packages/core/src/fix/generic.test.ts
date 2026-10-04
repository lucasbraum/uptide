import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckReport, Finding } from '../domain/report.js';
import { genericPack } from '../packs/generic.js';
import { git } from './process.js';
import { prBody } from './report.js';
import { type FixServices, fix } from './run.js';
import type { FixRequest } from './types.js';
import { diagnostics, testWorkspaces } from './verify.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-generic-fix-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const V1 = 'export declare function fill(color: string): void;\n';
const V2 = 'export declare function fill(color: { name: string }): void;\n';

/** A committed repository on `paint` 1 (no pack exists for it) with `sites` calls that 2.0 breaks. */
function paintFixture(sites = 1) {
  const root = mkdtempSync(join(scratch, 'repo-'));
  mkdirSync(join(root, 'node_modules/paint'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module', dependencies: { paint: '1.0.0' } }),
  );
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      paint:\n        specifier: 1.0.0\n        version: 1.0.0\n",
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      include: ['*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'node_modules/paint/package.json'),
    JSON.stringify({ name: 'paint', version: '1.0.0', types: 'index.d.ts' }),
  );
  writeFileSync(join(root, 'node_modules/paint/index.d.ts'), V1);
  const files = Array.from({ length: sites }, (_, i) => `wall${i + 1}.ts`);
  for (const file of files)
    writeFileSync(join(root, file), "import { fill } from 'paint';\nfill('red');\n");
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const finding = (file: string, severity: Finding['severity'] = 'breaking'): Finding => ({
    change: {
      package: 'paint',
      from: '1.0.0',
      to: '2.0.0',
      path: 'fill',
      kind: 'signature',
      severity: 'breaking',
      confidence: 1,
      source: 'types',
      before: '(color: string) => void',
      after: '(color: { name: string }) => void',
    },
    usage: {
      file,
      line: 2,
      column: 6,
      endLine: 2,
      endColumn: 11,
      symbolPath: 'fill',
      access: 'call',
      snippet: "fill('red');",
      via: 'direct',
      compileCode: 2345,
      compileError:
        "Argument of type 'string' is not assignable to parameter of type '{ name: string; }'.",
    },
    severity,
    confidence: 1,
    fixability: 'assisted',
    reason: 'signature changed',
    ...(severity === 'breaking' ? { evidence: 'compiler' as const } : {}),
  });
  const report: CheckReport = {
    repo: root,
    workspaces: ['.'],
    summary: {
      packagesNeedingAttention: 1,
      breaking: sites,
      deprecated: 0,
      unverified: 0,
      unaffected: 0,
      notImported: 0,
      partiallyAnalyzed: 0,
      autoFixable: 0,
      skippedForTime: 0,
      failed: 0,
    },
    packages: [
      {
        name: 'paint',
        workspace: '.',
        tier: 'generic',
        installed: '1.0.0',
        latest: '2.0.0',
        target: '2.0.0',
        majorsBehind: 1,
        findings: files.map((file) => finding(file)),
        callSitesChecked: sites,
        status: 'breaking',
        unanalyzed: [],
        notes: [],
        timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
      },
    ],
  };
  const services: FixServices = {
    check: async () => report,
    diagnostics,
    tests: testWorkspaces,
    resolve: async () => '2.0.0',
    install: async (dir) => {
      writeFileSync(join(dir, 'node_modules/paint/index.d.ts'), V2);
      writeFileSync(
        join(dir, 'pnpm-lock.yaml'),
        readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replaceAll('1.0.0', '2.0.0'),
      );
    },
  };
  /** An agent that knows the answer and charges `costUsd` per call. */
  const fixer = (costUsd: number, seen: FixRequest[] = []) => ({
    id: 'test-model',
    fix: async (request: FixRequest) => {
      seen.push(request);
      const file = request.finding.usage.file;
      return {
        diff: `--- a/${file}\n+++ b/${file}\n@@ -2 +2 @@\n-fill('red');\n+fill({ name: 'red' });\n`,
        explanation: 'fill takes an object with the color name in 2.0',
        inputTokens: 100,
        outputTokens: 20,
        costUsd,
      };
    },
  });
  return { root, services, report, fixer, finding };
}

describe('fix for a dependency without a pack', () => {
  it('migrates through the agent, verifies with the compiler, and says there is no pack', async () => {
    const { root, services, fixer } = paintFixture();
    const seen: FixRequest[] = [];
    const result = await fix({ cwd: root, only: 'paint', fixer: fixer(0.01, seen) }, services);
    expect(result.tier).toBe('generic');
    expect(result.verification.passed).toBe(true);
    expect(result.sites.map((s) => s.outcome)).toEqual(['agent']);
    expect(readFileSync(join(root, 'wall1.ts'), 'utf8')).toContain("fill({ name: 'red' });");
    expect(git(root, 'branch', '--show-current')).toBe('uptide/paint-2.0.0');
    // The guide is made of what the check found, and forbids hiding the error.
    expect(seen[0]?.guide).toContain('Migrate this call site of paint from 1.0.0 to 2.0.0');
    expect(seen[0]?.guide).toContain('After: (color: { name: string }) => void');
    expect(seen[0]?.guide).toContain('Never cast, never suppress a diagnostic');
    // What check learned about the target travels with the finding into the guide.
    expect(
      genericPack('paint').guide({
        ...(seen[0]?.finding as Finding),
        details: ['paint 2.0.0 exports: fill, stroke'],
      }),
    ).toContain('paint 2.0.0 exports: fill, stroke');
    const body = prBody(result);
    expect(body).toContain(
      '> No migration pack covers `paint`. Every edit here was written by the agent and kept only because the compiler error at that site went away and no new one appeared: review each change carefully.',
    );
    expect(body).toContain(
      '| **Risk** | Medium: no migration pack for paint: agent edits verified by the compiler only |',
    );
    expect(body).not.toMatch(/billing|webhook|Stripe/);
  }, 20000);

  it('refuses plainly without an agent, before anything changes', async () => {
    for (const [fixerOption, why] of [
      [null, 'assisted fixes are off (--no-llm)'],
      [undefined, 'ANTHROPIC_API_KEY is not set'],
    ] as const) {
      const { root, services } = paintFixture();
      const key = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        await expect(
          fix(
            { cwd: root, only: 'paint', ...(fixerOption === null ? { fixer: null } : {}) },
            services,
          ),
        ).rejects.toMatchObject({
          code: 'NO_FIXER',
          message: `paint has no migration pack, so every fix would come from the agent, and ${why}`,
        });
      } finally {
        if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
      }
      expect(git(root, 'branch', '--show-current')).not.toContain('uptide/');
      expect(git(root, 'status', '--porcelain')).toBe('');
    }
  });

  it('stops at --max-cost, keeps what was verified, and says what was not attempted', async () => {
    const { root, services, fixer } = paintFixture(3);
    const seen: FixRequest[] = [];
    const result = await fix(
      { cwd: root, only: 'paint', fixer: fixer(0.6, seen), maxCostUsd: 1 },
      services,
    );
    // $0.60 per site: two fit under $1 (the second starts at 0.60), the third never starts.
    expect(seen).toHaveLength(2);
    expect(result.sites.map((s) => s.outcome).sort()).toEqual(['agent', 'agent', 'manual']);
    expect(result.llm.costLimit).toEqual({ limitUsd: 1, notAttempted: 1 });
    expect(result.sites.find((s) => s.outcome === 'manual')?.reason).toContain(
      'not attempted: the cost limit of $1.00 was reached (--max-cost)',
    );
    // One site still fails to compile: the run is not verified, so nothing could be published.
    expect(result.verification.passed).toBe(false);
    expect(prBody(result)).toContain(
      '- The agent stopped at the cost limit of $1.00 (`--max-cost`): 1 site not attempted. Run again with a higher limit to continue.',
    );
  }, 30000);

  it('leaves a site nothing confirmed to a person', async () => {
    const { root, services, fixer, report, finding } = paintFixture();
    (report.packages[0] as (typeof report.packages)[number]).findings = [
      finding('wall1.ts', 'unverified'),
    ];
    const seen: FixRequest[] = [];
    const result = await fix({ cwd: root, only: 'paint', fixer: fixer(0.01, seen) }, services);
    expect(seen).toEqual([]);
    expect(result.sites).toEqual([]);
  }, 20000);
});
