import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { expect, it } from 'vitest';
import { unresolvedConfig } from './compiler.js';

const project = (config: object, files: Record<string, object> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-unresolved-'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return join(dir, 'tsconfig.json');
};

it('names an extends that points to a package that is not installed', () => {
  const tsconfig = project({ extends: '@not-installed/base/tsconfig.json' });
  expect(unresolvedConfig(ts, tsconfig)).toBe(
    'extends "@not-installed/base/tsconfig.json" cannot be resolved',
  );
});

it('accepts a config without extends, and one whose extends resolves', () => {
  expect(unresolvedConfig(ts, project({ compilerOptions: { strict: true } }))).toBeUndefined();
  const tsconfig = project(
    { extends: './base.json' },
    { 'base.json': { compilerOptions: { strict: true } } },
  );
  expect(unresolvedConfig(ts, tsconfig)).toBeUndefined();
});

it('says nothing for a file it cannot read', () => {
  expect(
    unresolvedConfig(ts, join(tmpdir(), 'uptide-no-such-dir', 'tsconfig.json')),
  ).toBeUndefined();
});
