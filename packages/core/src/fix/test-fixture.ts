import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport, Finding } from '../domain/report.js';
import { git } from './process.js';
import type { FixServices } from './run.js';
import { diagnostics, testWorkspaces } from './verify.js';

/** A committed single-package repository on zod 3 with one site the error-params rule migrates. */
export function zodFixture(scratch: string) {
  const root = mkdtempSync(join(scratch, 'repo-'));
  mkdirSync(join(root, 'node_modules/zod'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module', dependencies: { zod: '3.25.76' } }),
  );
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      zod:\n        specifier: 3.25.76\n        version: 3.25.76\n",
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
      include: ['index.ts'],
    }),
  );
  writeFileSync(
    join(root, 'node_modules/zod/package.json'),
    JSON.stringify({ name: 'zod', version: '3.25.76', types: 'index.d.ts' }),
  );
  writeFileSync(
    join(root, 'node_modules/zod/index.d.ts'),
    'export declare const z: { string(options: {required_error:string}): string };',
  );
  writeFileSync(
    join(root, 'index.ts'),
    "import { z } from 'zod';\nexport const schema = z.string({ required_error: 'required' });\n",
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const finding: Finding = {
    change: {
      package: 'zod',
      from: '3.25.76',
      to: '4.6.5',
      path: 'string',
      kind: 'signature',
      severity: 'breaking',
      confidence: 1,
      source: 'types',
    },
    usage: {
      file: 'index.ts',
      line: 2,
      column: 23,
      endLine: 2,
      endColumn: 31,
      symbolPath: 'string',
      access: 'call',
      snippet: '',
      via: 'direct',
      compileCode: 2353,
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'mechanical',
    reason: 'required_error removed',
  };
  const report: CheckReport = {
    repo: root,
    workspaces: ['.'],
    summary: {
      packagesNeedingAttention: 1,
      breaking: 1,
      deprecated: 0,
      unverified: 0,
      unaffected: 0,
      notImported: 0,
      partiallyAnalyzed: 0,
      autoFixable: 1,
    },
    packages: [
      {
        name: 'zod',
        workspace: '.',
        installed: '3.25.76',
        latest: '4.6.5',
        target: '4.6.5',
        majorsBehind: 1,
        findings: [finding],
        callSitesChecked: 1,
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
    // What `latest` means in these tests: the version the stand-in registry serves.
    resolve: async () => '4.6.5',
    // Like a real install, it writes where it is told to: the directory the run works in.
    install: async (dir) => {
      writeFileSync(
        join(dir, 'node_modules/zod/index.d.ts'),
        'export declare const z: { string(options: {error:(iss:{input:unknown})=>string|undefined}): string };',
      );
      writeFileSync(
        join(dir, 'pnpm-lock.yaml'),
        readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replaceAll('3.25.76', '4.6.5'),
      );
    },
  };
  return { root, services };
}

/**
 * A committed single-package repository on stripe 14 (a stand-in SDK: the constructor, its
 * config type and the pinned API date) with two clients, one unpinned and one pinned.
 */
export function stripeFixture(scratch: string) {
  const root = mkdtempSync(join(scratch, 'stripe-repo-'));
  mkdirSync(join(root, 'node_modules/stripe/cjs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module', dependencies: { stripe: '14.25.0' } }),
  );
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      stripe:\n        specifier: 14.25.0\n        version: 14.25.0\n",
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
      },
      include: ['src'],
    }),
  );
  writeFileSync(
    join(root, 'node_modules/stripe/package.json'),
    JSON.stringify({ name: 'stripe', version: '14.25.0', types: 'index.d.ts' }),
  );
  writeFileSync(
    join(root, 'node_modules/stripe/cjs/apiVersion.d.ts'),
    "export declare const ApiVersion = '2023-10-16';\n",
  );
  writeFileSync(
    join(root, 'node_modules/stripe/index.d.ts'),
    [
      'declare class Stripe {',
      '  constructor(key: string, config?: Stripe.StripeConfig);',
      '  customers: { retrieve(id: string): Promise<Stripe.Customer> };',
      '}',
      'declare namespace Stripe {',
      "  interface StripeConfig { apiVersion?: '2023-10-16'; maxNetworkRetries?: number }",
      '  interface Customer { id: string; email: string | null }',
      '}',
      'export = Stripe;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src/billing.ts'),
    [
      "import Stripe from 'stripe';",
      '',
      "export const stripe = new Stripe(process.env.STRIPE_KEY ?? '');",
      "export const pinned = new Stripe('sk', { apiVersion: '2023-10-16' });",
      "export const retried = new Stripe('sk', {",
      '  maxNetworkRetries: 2,',
      '});',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const services: FixServices = {
    check: async () => {
      throw new Error('a pin run never calls check');
    },
    diagnostics,
    tests: testWorkspaces,
    install: async () => {
      throw new Error('a pin run never installs');
    },
  };
  return { root, services };
}
