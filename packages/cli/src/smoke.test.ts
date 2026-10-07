import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckReport } from '@uptide/core';
import { afterEach, expect, it } from 'vitest';
import { formatCheck } from './format-check.js';

const smoke = fileURLToPath(new URL('../smoke/run.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'uptide-smoke-test-'));
  roots.push(root);
  return root;
}
function executable(root: string, name: string, code: string) {
  writeFileSync(join(root, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
}
function runner(root: string) {
  return spawnSync(process.execPath, [smoke, '20'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: root,
      TMPDIR: root,
      GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
    },
  });
}

it.each(['missing executable', 'unavailable daemon'])(
  'explains Docker is required (%s)',
  (mode) => {
    const root = temp();
    if (mode === 'unavailable daemon') executable(root, 'docker', 'process.exit(1);');
    executable(
      root,
      'pnpm',
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'built'))}, 'unexpected');`,
    );
    const result = runner(root);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Docker is required for pnpm smoke');
    expect(result.stdout).toBe('');
    expect(() => readFileSync(join(root, 'built'))).toThrow();
  },
);

it.each([0, 1])('preserves container assertions in the CI summary (exit %i)', (code) => {
  const root = temp();
  executable(root, 'pnpm', 'process.exit(0);');
  executable(
    root,
    'docker',
    `
    const fs = require('node:fs');
    if (process.argv[2] === 'info') process.exit(0);
    const out = process.argv.find(arg => arg.endsWith(':/tarball')).slice(0, -9);
    const report = {
      results: [{fixture: 'npm'}],
      failures: ${JSON.stringify(code ? ['npm check: expected major ×8\nactual: major'] : [])},
    };
    fs.writeFileSync(out + '/results.json', JSON.stringify(report));
    process.exit(${code});
  `,
  );
  const result = runner(root);
  const reportPath = result.stdout.match(/results saved to (.*)/)?.[1];
  if (reportPath) roots.push(join(reportPath, '..'));
  expect(result.status).toBe(code);
  const summary = readFileSync(join(root, 'summary.md'), 'utf8');
  expect(summary).toContain('Smoke: Node 20');
  expect(summary).toContain(
    code ? 'Failed (1 fixtures, 1 failed assertions)' : 'Passed (1 fixtures, 0 failed assertions)',
  );
  if (code) {
    expect(summary).toContain('npm check: expected major ×8\nactual: major');
    expect(result.stderr).toContain('1 assertion(s) failed');
    expect(result.stderr).not.toContain('node:internal');
  }
});

it('reports container startup failure without an uncaught exception', () => {
  const root = temp();
  executable(root, 'pnpm', 'process.exit(0);');
  executable(root, 'docker', "process.exit(process.argv[2] === 'info' ? 0 : 125);");
  const result = runner(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('container failed (125)');
  expect(result.stderr).not.toContain('node:internal');
  expect(readFileSync(join(root, 'summary.md'), 'utf8')).toContain(
    'Container did not produce results.json',
  );
});

it.each(['npm', 'npm-workspaces', 'pnpm', 'yarn', 'yarn-berry'])(
  'runs the actual smoke assertions against the formatter (%s)',
  async (fixture) => {
    const { checkReportFailures } = (await import(
      new URL('../smoke/check-output.mjs', import.meta.url).href
    )) as { checkReportFailures(output: string, fixture: string, manager: string): string[] };
    const report = JSON.parse(
      readFileSync(new URL('./__fixtures__/storefront-check.json', import.meta.url), 'utf8'),
    ) as CheckReport;
    const stripe = report.packages.find((pkg) => pkg.name === 'stripe');
    if (!stripe) throw new Error('Missing Stripe fixture');
    stripe.target = stripe.latest = '22.6.2';
    stripe.majorsBehind = 8;
    report.packages = [stripe];
    const workspace = fixture === 'pnpm' || fixture === 'npm-workspaces';
    if (!workspace) {
      stripe.workspace = '.';
      report.workspaces = ['.'];
    }
    const manager =
      fixture === 'npm-workspaces' ? 'npm' : fixture === 'yarn-berry' ? 'yarn' : fixture;
    const output = formatCheck(report, {
      color: false,
      header: { repo: `smoke-${fixture}`, manager, packages: workspace ? 2 : 0, ms: 100 },
      repeat: { targets: { stripe: '22.6.2' } },
    });
    expect(checkReportFailures(output, fixture, manager)).toEqual([]);
    // Keep both checks strict: these are the outdated forms that broke main's smoke run.
    const oldHeader = output.replace(
      `smoke-${fixture} · ${manager} ·`,
      `smoke-${fixture} (${manager}) ·`,
    );
    expect(checkReportFailures(oldHeader, fixture, manager)).toHaveLength(1);
    expect(
      checkReportFailures(output.replace('8 majors behind', 'major'), fixture, manager),
    ).toHaveLength(1);
  },
);

it('expects the command that reaches the build: npx uptide@next from a snapshot, npx uptide from a release', async () => {
  const { expectedInvocation, invocationFailures } = (await import(
    new URL('../smoke/check-output.mjs', import.meta.url).href
  )) as {
    expectedInvocation(version: string): string;
    invocationFailures(name: string, output: string, version: string): string[];
  };
  expect(expectedInvocation('0.5.0')).toBe('npx uptide');
  expect(expectedInvocation('0.5.0-next.20261007192842')).toBe('npx uptide@next');
  const next = 'Next: npx uptide@next check zod --details\n';
  expect(invocationFailures('fix', next, '0.5.0-next.20261007192842')).toEqual([]);
  expect(invocationFailures('fix', next, '0.5.0')[0]).toContain(
    'uptide 0.5.0 must suggest "npx uptide", not "npx uptide@next"',
  );
  expect(
    invocationFailures(
      'status',
      'Run `npx uptide list`, then `npx uptide check <package>`.',
      '0.5.0-next.1',
    )[0],
  ).toContain('must suggest "npx uptide@next", not "npx uptide"');
  expect(invocationFailures('fix', 'error: nothing to suggest\n', '0.5.0')[0]).toContain(
    'expected a suggestion with "npx uptide"',
  );
});
