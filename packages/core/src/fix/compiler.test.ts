import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { afterAll, expect, it } from 'vitest';
import {
  consumerCompilerDir,
  describeCompiler,
  repositoryCompiler,
  resolveCompiler,
} from '../adapters/typescript/compiler.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-compiler-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('prefers the consumer compiler to the bundled compiler', () => {
  const consumer = { ...ts, version: 'consumer' };
  expect(
    resolveCompiler(
      '/consumer',
      ts,
      (path) => {
        expect(path).toBe('/consumer/node_modules/typescript');
        return consumer;
      },
      () => '/consumer/node_modules/typescript',
    ),
  ).toBe(consumer);
});
it('uses the bundled compiler when the consumer has no TypeScript', () => {
  expect(
    resolveCompiler(
      '/consumer',
      ts,
      () => {
        throw new Error('never loaded');
      },
      () => undefined,
    ),
  ).toBe(ts);
});
it('explains how to recover if neither compiler exists', () => {
  expect(() =>
    resolveCompiler(
      '/consumer',
      null as unknown as typeof ts,
      () => {
        throw new Error('missing');
      },
      () => undefined,
    ),
  ).toThrow('TypeScript compiler unavailable');
});
it("finds the repository's own TypeScript in an ancestor, and nothing else", () => {
  // A workspace below the root that installs it: the root's copy is the one its build uses.
  const root = join(scratch, 'repo');
  const workspace = join(root, 'packages', 'app');
  mkdirSync(workspace, { recursive: true });
  expect(consumerCompilerDir(workspace)).toBeUndefined();
  const own = join(root, 'node_modules', 'typescript');
  mkdirSync(own, { recursive: true });
  writeFileSync(
    join(own, 'package.json'),
    JSON.stringify({ name: 'typescript', version: '0.0.0-own', main: 'index.js' }),
  );
  writeFileSync(join(own, 'index.js'), "module.exports = { version: '0.0.0-own' };");
  expect(consumerCompilerDir(workspace)).toBe(own);
  expect(resolveCompiler(workspace).version).toBe('0.0.0-own');
});
it('never takes a compiler from NODE_PATH or the global folders', () => {
  // Whatever this machine has installed globally, a repository without TypeScript gets the
  // bundled compiler (a global 6.x once made a test see TS5107 that CI never saw).
  const bare = join(scratch, 'bare');
  mkdirSync(bare, { recursive: true });
  expect(resolveCompiler(bare)).toBe(ts);
});

it("names the repository's compiler for the coverage line, and the bundled one when there is none", () => {
  // The scratch repository made above installs a stub; the bare directory installs nothing.
  const own = repositoryCompiler(join(scratch, 'repo', 'packages', 'app'));
  expect(own).toMatchObject({ version: '0.0.0-own', own: true });
  expect(describeCompiler(own)).toBe("the repo's TypeScript 0.0.0-own");
  const bundled = repositoryCompiler(join(scratch, 'bare'));
  expect(bundled).toMatchObject({ ts, version: ts.version, own: false });
  expect(describeCompiler(bundled)).toBe(`the bundled TypeScript ${ts.version}`);
  // Loaded once per install directory: two workspaces under one root share the module.
  expect(repositoryCompiler(join(scratch, 'repo'))).toBe(own);
});
