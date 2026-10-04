import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CheckResult, FixReport } from '@uptide/core';
import type { Engine } from './engine.js';
import type { Io } from './io.js';

/** The escape character that starts every terminal control sequence. */
export const ESC = String.fromCharCode(27);

export interface MemoryIo extends Io {
  stdout(): string;
  stderr(): string;
}

/** An Io that records. Not a terminal unless asked, like a CI log. */
export function memoryIo(overrides: Partial<Io> = {}): MemoryIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    env: {},
    cwd: process.cwd(),
    outTty: false,
    errTty: false,
    now: () => Date.now(),
    ...overrides,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** A throwaway directory with these files; paths are relative, parents are created. */
export function tempRepo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uptide-cli-')));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A single-package npm repository on zod 3 and stripe 14, installed. */
export function npmRepo(extra: Record<string, string> = {}): string {
  return tempRepo({
    'package.json': JSON.stringify({
      name: 'shop',
      dependencies: { zod: '^3.23.8', stripe: '14.25.0' },
    }),
    'package-lock.json': '{}',
    'node_modules/zod/package.json': '{"name":"zod","version":"3.23.8"}',
    'node_modules/stripe/package.json': '{"name":"stripe","version":"14.25.0"}',
    ...extra,
  });
}

/** A committed pnpm repository on zod 3, installed: what `fix` accepts. */
export function pnpmGitRepo(extra: Record<string, string> = {}): string {
  const root = tempRepo({
    'package.json': JSON.stringify({
      name: 'shop',
      packageManager: 'pnpm@10.17.1',
      dependencies: { zod: '^3.23.8', stripe: '14.25.0' },
    }),
    'pnpm-lock.yaml': '',
    '.gitignore': 'node_modules/\n',
    'node_modules/zod/package.json': '{"name":"zod","version":"3.23.8"}',
    'node_modules/stripe/package.json': '{"name":"stripe","version":"14.25.0"}',
    ...extra,
  });
  const git = (...args: string[]): void =>
    void execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'ignore',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  return root;
}

export function checkResult(summary: Partial<CheckResult['summary']> = {}): CheckResult {
  return {
    repo: '/repo',
    workspaces: ['.'],
    packages: [],
    summary: {
      packagesNeedingAttention: 0,
      breaking: 0,
      deprecated: 0,
      unverified: 0,
      unaffected: 0,
      notImported: 0,
      partiallyAnalyzed: 0,
      autoFixable: 0,
      skippedForTime: 0,
      failed: 0,
      ...summary,
    },
    timing: { totalMs: 1 },
  };
}

export function fixReport(passed: boolean): FixReport {
  return {
    repo: '/repo',
    package: 'zod',
    target: '4.6.5',
    branch: 'uptide/zod-4.6.5',
    sites: [],
    verification: {
      baseline: [],
      target: [],
      after: [],
      newErrors: [],
      baselineTests: [],
      tests: [],
      passed,
    },
    llm: { inputTokens: 0, outputTokens: 0, costUsd: 0, available: false },
    timingMs: 1,
    prBody: '/repo/.uptide/pr-body.md',
    notes: [],
  };
}

/** An engine that answers from memory and records what it was asked. */
export function fakeEngine(overrides: Partial<Engine> = {}): Engine & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    check: async (request) => {
      calls.push(request);
      return checkResult();
    },
    fix: async (request) => {
      calls.push(request);
      return fixReport(true);
    },
    diff: async () => [],
    latest: async (name) => (name === 'zod' ? '4.6.5' : '22.6.2'),
    workspaces: async () => ['.'],
    installed: async () =>
      new Map([
        ['zod', '3.23.8'],
        ['stripe', '14.25.0'],
      ]),
    declared: async () =>
      new Map([
        ['zod', '^3.23.8'],
        ['stripe', '14.25.0'],
      ]),
    ...overrides,
  };
}
