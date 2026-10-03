import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasTopLevelAwait,
  type Manifest,
  minimumVersion,
  moduleFormatChange,
  requireEsmSupport,
  resolveNodeVersion,
  shipsTypes,
  supportsRequire,
} from './module-format.js';

const ROOT = resolve(import.meta.dirname, '../../../../fixtures/module-format');
const manifest = (name: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, name, 'package.json'), 'utf8')) as Manifest;

describe('supportsRequire', () => {
  it.each([
    ['file-type-16', true],
    ['file-type-22', false],
    ['p-limit-3', true],
    ['p-limit-6', false],
    ['node-fetch-2', true],
    ['node-fetch-3', false],
    ['dual-2', true],
  ])('%s -> %s', (name, expected) => {
    expect(supportsRequire(manifest(name))).toBe(expected);
  });
});

describe('requireEsmSupport', () => {
  it.each([
    // A bare major is its latest release, which has require(esm) for 20 and 22.
    ['>=22', 'yes'],
    ['22', 'yes'],
    ['20', 'yes'],
    ['22.x', 'yes'],
    ['18', 'no'],
    ['>=22.12', 'yes'],
    ['22.14.0', 'yes'],
    ['22.11', 'no'],
    ['20.19.0', 'yes'],
    ['20.18', 'no'],
    ['^20.10.0', 'no'],
    ['^18 || >=22.12', 'no'],
    [undefined, 'unknown'],
  ])('%s -> %s', (range, expected) => {
    expect(requireEsmSupport(range)).toBe(expected);
  });
  it('reads the lowest version a range admits', () => {
    expect(minimumVersion('4.x || >=6.0.0')).toBe('4.0.0');
    expect(minimumVersion('^12.20.0 || ^14.13.1 || >=16.0.0')).toBe('12.20.0');
  });
});

describe('moduleFormatChange', () => {
  const meta = { package: 'x', from: '1', to: '2' };
  it.each(['file-type-16:file-type-22', 'p-limit-3:p-limit-6', 'node-fetch-2:node-fetch-3'])(
    'emits a module-format change for %s',
    (pair) => {
      const [a, b] = pair.split(':') as [string, string];
      const change = moduleFormatChange(manifest(a), manifest(b), meta, {
        range: '>=22',
        support: 'no',
      });
      expect(change).toMatchObject({
        kind: 'module-format',
        severity: 'breaking',
        path: '.',
        requireEsm: 'no',
      });
      expect(change?.notes).toMatch(/^no longer loadable with require\(\): "type": "module"/);
      expect(change?.notes).toMatch(/does not guarantee require\(esm\)/);
    },
  );
  it('emits nothing when require keeps working', () => {
    expect(
      moduleFormatChange(manifest('p-limit-3'), manifest('dual-2'), meta, {
        range: undefined,
        support: 'unknown',
      }),
    ).toBeUndefined();
    expect(
      moduleFormatChange(manifest('file-type-22'), manifest('file-type-22'), meta, {
        range: undefined,
        support: 'unknown',
      }),
    ).toBeUndefined();
  });
  it('says what require(esm) changes when Node supports it', () => {
    const change = moduleFormatChange(manifest('p-limit-3'), manifest('p-limit-6'), meta, {
      range: '22.14.0',
      support: 'yes',
    });
    expect(change?.notes).toMatch(
      /supports require\(esm\): require\(\) returns the module namespace/,
    );
  });
});

describe('shipsTypes', () => {
  const LAYOUTS = resolve(import.meta.dirname, '../../../../fixtures/typed-layouts');
  it('sees a declaration next to an exports target, not only a types field', () => {
    expect(shipsTypes(join(LAYOUTS, 'sibling'))).toBe(true);
    expect(shipsTypes(join(LAYOUTS, 'main-dir'))).toBe(true);
    expect(shipsTypes(join(LAYOUTS, 'none'))).toBe(false);
  });
});

describe('resolveNodeVersion', () => {
  it('reads the most binding source first and names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-node-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', engines: { node: '>=22' } }),
    );
    expect(resolveNodeVersion([dir])).toEqual({
      range: '>=22',
      source: 'package.json engines.node',
    });
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github/workflows/ci.yml'),
      'steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 22\n',
    );
    expect(resolveNodeVersion([dir])).toEqual({ range: '22', source: '.github/workflows/ci.yml' });
    writeFileSync(join(dir, '.tool-versions'), 'nodejs 22.14.0\n');
    expect(resolveNodeVersion([dir])).toEqual({ range: '22.14.0', source: '.tool-versions' });
    writeFileSync(join(dir, '.nvmrc'), 'v20.19.1\n');
    expect(resolveNodeVersion([dir])).toEqual({ range: '20.19.1', source: '.nvmrc' });
    mkdirSync(join(dir, 'docker'), { recursive: true });
    writeFileSync(join(dir, 'docker/Dockerfile'), 'FROM node:24.2-alpine AS base\nRUN true\n');
    expect(resolveNodeVersion([dir])).toEqual({ range: '24.2', source: 'docker/Dockerfile' });
    // A custom base image: production Node unknown, the next source answers and says so.
    writeFileSync(join(dir, 'docker/Dockerfile'), 'FROM ghcr.io/acme/base:5 AS base\n');
    expect(resolveNodeVersion([dir])).toEqual({
      range: '20.19.1',
      source: '.nvmrc',
      caveat:
        'production Node unknown: docker/Dockerfile uses a custom base image (ghcr.io/acme/base:5)',
    });
  });
});

describe('hasTopLevelAwait', () => {
  it('sees an await outside any function in the target graph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-tla-'));
    writeFileSync(
      join(dir, 'index.js'),
      'export const ready = await Promise.resolve(1);\nexport async function f() { await 1; }\n',
    );
    expect(hasTopLevelAwait(dir)).toBe(true);
    writeFileSync(
      join(dir, 'index.js'),
      'export async function f() { await 1; }\nexport const g = async () => { for await (const x of []) {} };\n',
    );
    expect(hasTopLevelAwait(dir)).toBe(false);
  });
});
