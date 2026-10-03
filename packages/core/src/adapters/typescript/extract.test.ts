import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoTypesError } from '../../errors.js';
import { resolveEntryPoints } from './entry-points.js';
import { createTypescriptAdapter } from './index.js';

const FIXTURE = resolve(import.meta.dirname, '../../../../../fixtures/synthetic');
const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-27T00:00:00.000Z') });

async function surface() {
  return adapter.extractSurface({ name: 'synthetic', version: '1.0.0', dir: FIXTURE });
}

describe('resolveEntryPoints', () => {
  it('reads the exports map with nested conditions, root first', () => {
    const entries = resolveEntryPoints(FIXTURE, 'synthetic', '1.0.0');
    expect(entries.map((e) => e.entry)).toEqual(['.', './ambient', './cjs', './legacy', './utils']);
    expect(entries.map((e) => e.file.replace(FIXTURE, ''))).toEqual([
      '/dist/index.d.ts',
      '/dist/sub/ambient.d.ts',
      '/dist/sub/cjs.d.ts',
      '/dist/sub/legacy.d.ts',
      '/dist/sub/utils.d.ts',
    ]);
  });

  it('throws NoTypesError when nothing declares types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-notypes-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), '');
    expect(() => resolveEntryPoints(dir, 'x', '1.0.0')).toThrow(NoTypesError);
  });

  it('prefers the ESM declaration when the types condition splits by module system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-dual-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        exports: { '.': { types: { require: './index.d.cts', default: './index.d.ts' } } },
      }),
    );
    writeFileSync(join(dir, 'index.d.cts'), 'export {};');
    writeFileSync(join(dir, 'index.d.ts'), 'export {};');
    expect(resolveEntryPoints(dir, 'x', '1.0.0')).toEqual([
      { entry: '.', file: join(dir, 'index.d.ts') },
    ]);
  });

  it('enumerates implicit subpaths when there is no exports map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-implicit-'));
    mkdirSync(join(dir, 'legacy'));
    mkdirSync(join(dir, 'build/deep'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', types: 'build/index.d.ts' }),
    );
    writeFileSync(join(dir, 'build/index.d.ts'), 'export {};');
    writeFileSync(join(dir, 'build/deep/internal.d.ts'), 'export {};');
    writeFileSync(join(dir, 'navigation.d.ts'), 'export {};');
    writeFileSync(
      join(dir, 'legacy/package.json'),
      JSON.stringify({ types: '../build/legacy.d.ts' }),
    );
    writeFileSync(join(dir, 'build/legacy.d.ts'), 'export {};');
    expect(resolveEntryPoints(dir, 'x', '1.0.0').map((e) => e.entry)).toEqual([
      '.',
      './legacy',
      './navigation',
    ]);
  });

  it('does not enumerate implicit subpaths when an exports map exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-explicit-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', exports: { '.': { types: './index.d.ts' } } }),
    );
    writeFileSync(join(dir, 'index.d.ts'), 'export {};');
    writeFileSync(join(dir, 'secret.d.ts'), 'export {};');
    expect(resolveEntryPoints(dir, 'x', '1.0.0').map((e) => e.entry)).toEqual(['.']);
  });

  it('finds a declaration next to main when there is no types field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-main-'));
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', main: 'lib/x.js' }));
    writeFileSync(join(dir, 'lib/x.d.ts'), 'export {};');
    expect(resolveEntryPoints(dir, 'x', '1.0.0')).toEqual([
      { entry: '.', file: join(dir, 'lib/x.d.ts') },
    ]);
  });
});

describe('extractSurface on fixtures/synthetic', () => {
  it('matches the reviewed snapshot', async () => {
    const s = await surface();
    await expect(JSON.stringify(s, null, 2)).toMatchFileSnapshot(
      join(FIXTURE, 'expected-surface.json'),
    );
  });

  it('is sorted by path with unique paths', async () => {
    const paths = (await surface()).symbols.map((s) => s.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does not list symbols no entry point reaches', async () => {
    const paths = (await surface()).symbols.map((s) => s.path);
    expect(paths).not.toContain('hiddenHelper');
    expect(paths.some((p) => p.includes('cache') || p.includes('secret'))).toBe(false);
  });

  it('records every entry point that reaches a symbol', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.parse?.exportedFrom).toEqual(['.', './utils']);
    expect(by.Item?.exportedFrom).toEqual(['.', './utils']);
    expect(by['Item#id']?.exportedFrom).toEqual(['.', './utils']);
    expect(by.slugify?.exportedFrom).toEqual(['./utils']);
  });

  it('scopes a colliding subpath export instead of merging it', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.Client?.exportedFrom).toEqual(['.']);
    expect(by['Client#get']).toBeDefined();
    expect(by['"./legacy":Client']?.exportedFrom).toEqual(['./legacy']);
    expect(by['"./legacy":Client#connect']).toBeDefined();
    expect(by['"./legacy":Client.new()']?.signature).toBe('(host: string, port: number)');
  });

  it('captures @deprecated text and bare tags', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.parseLegacy?.deprecated).toBe('use {@link parse} instead');
    expect(by['Parser#reset']?.deprecated).toBe(true);
    expect(by['Parser.new()']?.deprecated).toBe('construct with {@link createParser}');
    expect(by['Item#legacyId']?.deprecated).toBe('use id');
    expect(by.parse?.deprecated).toBeUndefined();
  });

  it('normalizes signatures: unions sorted, overloads joined, comments gone', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.Loose?.signature).toBe("type = 'a' | 'm' | 'z'");
    expect(by['ParseOptions#mode']?.signature).toBe("'auto' | 'loose' | 'strict'");
    expect(by.parse?.signature).toBe(
      '(input: string): Item; (input: string, options: ParseOptions): Item',
    );
    expect(by['Parser#parse']?.signature).toBe('(input: string): T; (input: Buffer): T');
  });

  it('expands anonymous object types but not named ones', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by['ParseOptions#hooks']?.signature).toBe('{…}');
    expect(by['ParseOptions#hooks#onStart']?.signature).toBe('(): void');
    expect(by['ParseOptions#hooks#onEnd']?.optional).toBe(true);
    expect(by['ParseOptions#items']?.signature).toBe('Array<{…}>');
    expect(by['ParseOptions#items[]#quantity']).toMatchObject({
      optional: true,
      signature: 'number',
    });
    expect(by['ParseOptions#named']?.signature).toBe('Item[]');
    expect(by['ParseOptions#named[]#id']).toBeUndefined();
    expect(by['Pair#left']?.signature).toBe('T');
    expect(by.Shape?.signature).toBe(
      "type = { kind: 'circle'; radius: number } | { kind: 'square'; side: number }",
    );
  });

  it('separates static and instance members and drops private ones', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.Parser).toMatchObject({ kind: 'class', signature: 'class<T = Item>' });
    expect(by['Parser.create']?.signature).toBe('(options?: ParseOptions): Parser');
    expect(by['Parser.version']?.signature).toBe('string');
    expect(by['Parser#version']?.signature).toBe('number');
    expect(by['Parser#options']?.signature).toBe('readonly ParseOptions');
    expect(by['Parser#warn']?.signature).toBe('protected (message: string): void');
    expect(by['Parser#size']?.signature).toBe('readonly number');
    expect(by['Parser#name']?.signature).toBe('string');
    expect(by['Parser#cache']).toBeUndefined();
    expect(by['Parser.Stats#parsed']?.signature).toBe('number');
    expect(by['Parser.Internals.flag']?.signature).toBe('const boolean');
  });

  it('keeps the declared name as root for export = and separates its three member spaces', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.Api).toMatchObject({ kind: 'class', signature: 'class', exportedFrom: ['./cjs'] });
    expect(by['Api.new()']?.signature).toBe('(key: string)');
    expect(by['Api.version']?.signature).toBe('string');
    expect(by['Api.errors']).toMatchObject({ kind: 'namespace', signature: 'namespace' });
    // A namespace's typeof prints as itself; nothing to expand.
    expect(by['Api#errors']?.signature).toBe('typeof Api.errors');
    expect(by['Api.errors.ApiError']).toMatchObject({
      kind: 'class',
      signature: 'class extends Error',
    });
    expect(by['Api.errors.ApiError#status']?.signature).toBe('number');
    expect(by['Api.Response#data']?.optional).toBe(true);
    expect(by['Api#request']?.signature).toBe('(path: string): Promise<Api.Response>');
    // Members of the export= target are not also flattened to top level.
    expect(by.Response).toBeUndefined();
    expect(by.errors).toBeUndefined();
  });

  it('walks own-package ambient modules as the entry, merging reference-directive blocks', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.Thing?.exportedFrom).toEqual(['./ambient']);
    expect(by['Thing#a']?.signature).toBe('number');
    expect(by['Thing#b']?.optional).toBe(true);
    expect(by.make?.signature).toBe('(): Thing');
    expect(by['"synthetic/ambient":Thing']).toBeUndefined();
  });

  it('marks aliases of a declaration with the shortest path as canonical', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by.createClient?.aliasOf).toBeUndefined();
    expect(by.makeClient?.aliasOf).toBe('createClient');
    expect(by.shapes).toMatchObject({ kind: 'namespace' });
    expect(by['shapes.Circle']?.aliasOf).toBe('Circle');
    expect(by['shapes.Circle#radius']?.aliasOf).toBe('Circle#radius');
    expect(by.Circle?.aliasOf).toBeUndefined();
    // Same path from two entry points is one symbol, not an alias.
    expect(by.Item?.aliasOf).toBeUndefined();
  });

  it('marks protected members and @internal subtrees, leaving public symbols unmarked', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by['Parser#warn']?.visibility).toBe('protected');
    expect(by.internalHelper?.visibility).toBe('internal');
    expect(by.InternalState?.visibility).toBe('internal');
    expect(by['InternalState#ticks']?.visibility).toBe('internal');
    expect(by['Parser#parse']?.visibility).toBeUndefined();
    expect(by.parse?.visibility).toBeUndefined();
  });

  it('handles signatures, enums, quoted names and default export', async () => {
    const by = Object.fromEntries((await surface()).symbols.map((s) => [s.path, s]));
    expect(by['Callable#()']?.signature).toBe('(input: string): Item');
    expect(by['Callable.new()']?.signature).toBe('(input: string): Callable');
    expect(by['Headers#"content-type"']?.optional).toBe(true);
    expect(by['Headers#[string]']?.signature).toBe('string | undefined');
    expect(by['Level.Custom']?.signature).toBe('"custom"');
    expect(by['Level.High']?.signature).toBe('1');
    expect(by.default?.signature).toBe('const {…}');
    // `typeof parse` is an indirection; the queried type is what consumers see.
    expect(by['default#parse']?.signature).toBe(
      '{ (input: string): Item; (input: string, options: ParseOptions): Item }',
    );
    // ./utils re-exports from the root file, so it pulls the augmentation in too.
    expect(by['"other-pkg":Request#synthetic']?.exportedFrom).toEqual(['.', './utils']);
  });
});
