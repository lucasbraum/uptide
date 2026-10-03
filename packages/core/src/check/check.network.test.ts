import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckReport } from '../domain/report.js';
import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import { check } from './check.js';

/**
 * The precision tests of milestone 2: hand-written consumers pinned to versions we know
 * the changes of. Off by default; `UPTIDE_NETWORK=1` fetches the pinned package (cached)
 * and links it into a temp copy of the fixture as node_modules/<pkg>, the way an install
 * would, then runs `check` against an explicit target.
 */
const ROOT = resolve(import.meta.dirname, '../../../../fixtures/repos');
const fetcher = createNpmFetcher();

async function installed(fixture: string, name: string, version: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `uptide-${fixture}-`));
  cpSync(join(ROOT, fixture), dir, { recursive: true });
  const pkg = await fetcher.fetch(name, version);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(pkg.dir, join(dir, 'node_modules', name), 'dir');
  return dir;
}

/** Everything but timing, in a form a human can diff against a changelog. */
function digest(report: CheckReport): string {
  return JSON.stringify(
    report.packages.map((p) => ({
      name: p.name,
      installed: p.installed,
      target: p.target,
      status: p.status,
      callSitesChecked: p.callSitesChecked,
      notes: p.notes,
      compile: p.compile
        ? {
            ...p.compile,
            unattributed: p.compile.unattributed.map(
              (d) => `${d.file}:${d.line} TS${d.code} ${d.message}`,
            ),
          }
        : undefined,
      findings: p.findings
        .filter((f) => f.severity !== 'additive')
        .map(
          (f) =>
            `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.change.kind} ${f.severity} ${f.fixability} ${f.confidence} :: ${f.reason}${f.usage.compileError ? ` [tsc: ${f.usage.compileError.split('\n')[0]}]` : ''}`,
        ),
      additive: p.findings.filter((f) => f.severity === 'additive').length,
    })),
    null,
    2,
  );
}

describe.skipIf(!process.env.UPTIDE_NETWORK)('check on real consumers', () => {
  it('axios-consumer 0.27.2 -> 1.7.0', { timeout: 300_000 }, async () => {
    const cwd = await installed('axios-consumer', 'axios', '0.27.2');
    const report = await check({ cwd, targets: { axios: '1.7.0' } });
    await expect(digest(report)).toMatchFileSnapshot(
      join(ROOT, 'axios-consumer/expected-report.json'),
    );
  });

  it('zod-consumer 3.23.8 -> 4.0.0', { timeout: 300_000 }, async () => {
    const cwd = await installed('zod-consumer', 'zod', '3.23.8');
    const report = await check({ cwd, targets: { zod: '4.0.0' } });
    await expect(digest(report)).toMatchFileSnapshot(
      join(ROOT, 'zod-consumer/expected-report.json'),
    );
  });

  it('z.infer<typeof s> against zod 4.6.5 is not a deprecation: TypeOf is, infer is the name written', {
    timeout: 300_000,
  }, async () => {
    const cwd = await installed('zod-consumer', 'zod', '3.23.8');
    const report = await check({ cwd, targets: { zod: '4.6.5' } });
    const zod = report.packages.find((p) => p.name === 'zod');
    const atInfer =
      zod?.findings.filter((f) => f.usage.file === 'src/schema.ts' && f.usage.line === 17) ?? [];
    expect(atInfer.map((f) => f.usage.symbolPath)).toEqual(expect.arrayContaining(['infer']));
    expect(atInfer.filter((f) => f.change.kind === 'deprecated')).toEqual([]);
  });
});
