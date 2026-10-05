import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
      skippedForTime: 0,
      failed: 0,
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

/**
 * A pnpm workspace with the isolated node-linker: nothing is hoisted to the root, each
 * package sees `@types/node` only through its own `node_modules` symlink into the store.
 * The types declare a global no other `@types/node` has, so a program that picks up
 * whatever the process's working directory offers fails here too. Each package also uses
 * `greet` 1.0.0 (from the store, like everything else); `greet` 2.0.0 is in `greet-2.0.0/`
 * at the root, for an upgrade to compile against: it makes `greet` take a second argument.
 */
export function isolatedPnpmWorkspace(scratch: string): string {
  const root = mkdtempSync(join(scratch, 'isolated-'));
  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ name: 'root', private: true }));
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('.npmrc', 'node-linker=isolated\n');
  const importer = [
    '    dependencies:',
    '      greet:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '    devDependencies:',
    "      '@types/node':",
    '        specifier: ^24.0.0',
    '        version: 24.0.0',
  ];
  write(
    'pnpm-lock.yaml',
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .: {}',
      '  packages/a:',
      ...importer,
      '  packages/b:',
      ...importer,
      '',
    ].join('\n'),
  );
  const store = 'node_modules/.pnpm/@types+node@24.0.0/node_modules/@types/node';
  write(`${store}/package.json`, JSON.stringify({ name: '@types/node', version: '24.0.0' }));
  write(
    `${store}/index.d.ts`,
    [
      'declare var __fixtureNodeTypes: true;',
      'declare var Buffer: { from(text: string): { toString(encoding: string): string } };',
      "declare module 'node:crypto' { export function createHash(algorithm: string): { digest(encoding: string): string } }",
    ].join('\n'),
  );
  const greet = 'node_modules/.pnpm/greet@1.0.0/node_modules/greet';
  for (const [dir, version, signature] of [
    [greet, '1.0.0', 'name: string'],
    ['greet-2.0.0', '2.0.0', 'name: string, greeting: string'],
  ] as const) {
    write(`${dir}/package.json`, JSON.stringify({ name: 'greet', version, types: 'index.d.ts' }));
    write(`${dir}/index.d.ts`, `export declare function greet(${signature}): string;`);
  }
  const options = { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext' };
  write('tsconfig.base.json', JSON.stringify({ compilerOptions: { ...options, types: ['node'] } }));
  // One package names its types; the other inherits them from the root's base config, where
  // the root has no @types of its own to offer.
  const configs = {
    a: { compilerOptions: { ...options, types: ['node'] }, include: ['index.ts'] },
    b: { extends: '../../tsconfig.base.json', include: ['index.ts'] },
  };
  for (const [name, config] of Object.entries(configs)) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({
        name,
        dependencies: { greet: '1.0.0' },
        devDependencies: { '@types/node': '^24.0.0' },
      }),
    );
    write(`packages/${name}/tsconfig.json`, JSON.stringify(config));
    write(
      `packages/${name}/index.ts`,
      [
        "import { createHash } from 'node:crypto';",
        'export const seen: true = __fixtureNodeTypes;',
        "export const text: string = Buffer.from('x').toString('base64');",
        "export const hash: string = createHash('sha256').digest('hex');",
        "import { greet } from 'greet';",
        "export const hello: string = greet('world');",
      ].join('\n'),
    );
    mkdirSync(join(root, `packages/${name}/node_modules/@types`), { recursive: true });
    symlinkSync(join(root, store), join(root, `packages/${name}/node_modules/@types/node`), 'dir');
    symlinkSync(join(root, greet), join(root, `packages/${name}/node_modules/greet`), 'dir');
  }
  return root;
}
