import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTypescriptAdapter } from '../adapters/typescript/index.js';
import { diffSurfaces } from '../diff/diff.js';
import type { Change } from '../domain/change.js';
import type { ApiSurface } from '../domain/surface.js';
import type { CompileSignal, Usage, UsageAccess, UsageVia } from '../domain/usage.js';
import { deprecationReplacement, fixabilityOf } from './fixability.js';
import { match } from './match.js';
import { mergeSignals } from './merge.js';

const change = (
  c: Partial<Change> & { path: string; kind: Change['kind']; severity: Change['severity'] },
): Change => ({
  package: 'p',
  from: '1',
  to: '2',
  source: 'types',
  confidence: 1,
  ...c,
});
const usage = (
  symbolPath: string,
  access: UsageAccess,
  via: UsageVia = 'direct',
  extra: Partial<Usage> = {},
): Usage => ({
  file: 'src/a.ts',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  symbolPath,
  access,
  snippet: '',
  via,
  ...extra,
});

describe('match', () => {
  it('joins on the path and applies the direction table', () => {
    const widened = change({
      path: 'Config#signal',
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
    });
    const findings = match(
      [widened],
      [usage('Config#signal', 'read'), usage('Config#signal', 'write', 'direct', { line: 2 })],
    );
    expect(findings.map((f) => [f.usage.line, f.severity, f.reason])).toEqual([
      [1, 'breaking', 'widened type is read by the consumer'],
      [2, 'additive', 'widened type only receives values from the consumer'],
    ]);
    expect(findings[0]?.change.severity).toBe('additive');
  });

  it('a removed or moved container reaches usages of its members', () => {
    const removed = change({ path: 'Parser', kind: 'removed', severity: 'breaking' });
    const moved = change({
      path: 'Level',
      kind: 'moved',
      severity: 'breaking',
      replacement: './v3',
      confidence: 0.95,
    });
    const findings = match(
      [removed, moved],
      [
        usage('Parser#parse', 'call'),
        usage('Level.High', 'read', 'direct', { line: 2 }),
        usage('Other#x', 'read', 'direct', { line: 3 }),
      ],
    );
    expect(findings.map((f) => [f.usage.symbolPath, f.change.path, f.fixability])).toEqual([
      ['Parser#parse', 'Parser', 'manual'],
      ['Level.High', 'Level', 'mechanical'],
    ]);
    expect(findings[0]?.reason).toBe('Parser was removed; this member goes with it');
  });

  it('an alias usage matches changes on both its names', () => {
    const onTarget = change({
      path: 'createClient',
      kind: 'signature',
      severity: 'breaking',
      notes: "required parameter 'options' added",
    });
    const onAlias = change({ path: 'makeClient', kind: 'removed', severity: 'breaking' });
    const call = usage('makeClient', 'call', 'direct', { canonicalPath: 'createClient' });
    const findings = match([onTarget, onAlias], [call]);
    expect(findings.map((f) => f.change.path).sort()).toEqual(['createClient', 'makeClient']);
  });

  it('a compiler rejection outranks an additive direction verdict', () => {
    const narrowed = change({
      path: 'Headers',
      kind: 'narrowed',
      severity: 'breaking',
      confidence: 0.7,
    });
    const typeRef = usage('Headers', 'typeRef', 'direct', {
      compileError: "Type '{ a: string }' is not assignable to type 'Headers'.",
    });
    const f = match([narrowed], [typeRef]);
    expect(f[0]).toMatchObject({ severity: 'breaking' });
    expect(f[0]?.reason).toMatch(/^compiler rejects this usage: Type/);
    expect(match([narrowed], [usage('Headers', 'typeRef')])[0]?.severity).toBe('additive');
  });

  it('compiled mode: text-only and weak direction verdicts the compiler did not object to become possible runtime changes', () => {
    const textual = change({
      path: 'f',
      kind: 'signature',
      severity: 'breaking',
      confidence: 0.7,
      evidence: 'text',
      notes: 'return type changed',
    });
    const checker = change({
      path: 'g',
      kind: 'signature',
      severity: 'breaking',
      evidence: 'checker',
      notes: "parameter 'a' type narrowed",
    });
    const widened = change({
      path: 'P#w',
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
      evidence: 'checker',
    });
    const removed = change({ path: 'r', kind: 'removed', severity: 'breaking' });
    const confirmed = usage('f', 'call', 'direct', {
      line: 9,
      compileError: 'Expected 2 arguments, but got 1.',
    });
    const out = match(
      [textual, checker, widened, removed],
      [
        usage('f', 'call'),
        usage('g', 'call', 'direct', { line: 2 }),
        usage('P#w', 'read', 'direct', { line: 3 }),
        usage('r', 'read', 'direct', { line: 4 }),
        confirmed,
      ],
      { compiled: true },
    );
    const by = Object.fromEntries(out.map((f) => [`${f.change.path}:${f.usage.line}`, f]));
    // The compiler decides, the diff explains: every compile-time kind it accepted is info.
    expect(by['f:1']).toMatchObject({ severity: 'info', confidence: 0.3, fixability: 'none' });
    expect(by['f:1']?.reason).toBe('diff says signature but your code compiles against the target');
    expect(by['f:9']).toMatchObject({ severity: 'breaking' });
    expect(by['g:2']).toMatchObject({ severity: 'info' });
    // A widened read is breaking by the table; the compiler did not object, so it is downgraded.
    expect(by['P#w:3']).toMatchObject({ severity: 'info', confidence: 0.3 });
    expect(by['r:4']).toMatchObject({ severity: 'info' });
    expect(by['r:4']?.reason).toBe('diff says removed but your code compiles against the target');
    expect(match([textual], [usage('f', 'call')])[0]?.severity).toBe('breaking');

    // When the symbol's declaration file has unresolved imports in the target, silence proves nothing.
    const inconclusive = match([removed], [usage('r', 'read', 'direct', { line: 4 })], {
      compiled: true,
      unverifiedPaths: new Set(['r']),
    });
    expect(inconclusive[0]).toMatchObject({ severity: 'unverified', confidence: 1 });
    expect(inconclusive[0]?.reason).toMatch(/compile check inconclusive$/);
  });

  it('multiplies confidence by usage certainty', () => {
    const c = change({ path: 'x', kind: 'removed', severity: 'breaking', confidence: 0.8 });
    const f = match([c], [usage('x', 'read', 'destructure')]);
    expect(f[0]?.confidence).toBe(0.72);
    const g = match([c], [usage('x', 'read', 'inferred')]);
    expect(g[0]?.confidence).toBe(0.64);
    expect(g[0]?.fixability).toBe('unknown');
  });

  it('sorts breaking first, then by location', () => {
    const findings = match(
      [
        change({ path: 'a', kind: 'deprecated', severity: 'deprecated' }),
        change({ path: 'b', kind: 'removed', severity: 'breaking' }),
      ],
      [
        usage('a', 'read', 'direct', { file: 'src/a.ts' }),
        usage('b', 'read', 'direct', { file: 'src/z.ts' }),
      ],
    );
    expect(findings.map((f) => f.change.path)).toEqual(['b', 'a']);
  });
});

describe('fixability', () => {
  const u = usage('x', 'call');
  it('follows the table', () => {
    expect(
      fixabilityOf(change({ path: 'x', kind: 'moved', severity: 'breaking' }), u, 'breaking'),
    ).toBe('mechanical');
    expect(
      fixabilityOf(
        change({ path: 'x', kind: 'removed', severity: 'breaking', replacement: 'y' }),
        u,
        'breaking',
      ),
    ).toBe('mechanical');
    expect(
      fixabilityOf(change({ path: 'x', kind: 'removed', severity: 'breaking' }), u, 'breaking'),
    ).toBe('manual');
    expect(
      fixabilityOf(
        change({
          path: 'x',
          kind: 'deprecated',
          severity: 'deprecated',
          notes: 'Use `z.email()` instead.',
        }),
        u,
        'deprecated',
      ),
    ).toBe('mechanical');
    expect(
      fixabilityOf(
        change({
          path: 'x',
          kind: 'deprecated',
          severity: 'deprecated',
          notes: 'Try safe-parsing `null` (this is what `isNullable` does internally):',
        }),
        u,
        'deprecated',
      ),
    ).toBe('manual');
    expect(
      fixabilityOf(
        change({
          path: 'x',
          kind: 'signature',
          severity: 'breaking',
          notes: "parameter 'p' removed",
        }),
        u,
        'breaking',
      ),
    ).toBe('mechanical');
    expect(
      fixabilityOf(
        change({
          path: 'x',
          kind: 'signature',
          severity: 'breaking',
          notes: "required parameter 'p' added",
        }),
        u,
        'breaking',
      ),
    ).toBe('assisted');
    expect(
      fixabilityOf(change({ path: 'x', kind: 'type', severity: 'breaking' }), u, 'breaking'),
    ).toBe('assisted');
    expect(
      fixabilityOf(change({ path: 'x', kind: 'widened', severity: 'additive' }), u, 'additive'),
    ).toBe('none');
    expect(
      fixabilityOf(
        change({ path: 'x', kind: 'type', severity: 'breaking' }),
        usage('x', 'call', 'inferred'),
        'breaking',
      ),
    ).toBe('unknown');
  });

  it('reads a single bare replacement out of a deprecation message', () => {
    expect(deprecationReplacement('use {@link parse} instead')).toBe('parse');
    expect(deprecationReplacement('Use `z.email()` instead.')).toBe('z.email()');
    expect(deprecationReplacement('use paymentMethods instead')).toBe('paymentMethods');
    expect(deprecationReplacement('Push directly to `.issues` instead.')).toBeUndefined();
    expect(deprecationReplacement('Use spread syntax and the `.shape` property')).toBeUndefined();
    expect(deprecationReplacement(undefined)).toBeUndefined();
  });
});

describe('end to end on the synthetic fixtures', () => {
  const ROOT = resolve(import.meta.dirname, '../../../../fixtures');
  const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-27T00:00:00.000Z') });

  it('synthetic v1 -> v2 against the consumer produces the expected findings', async () => {
    const [a, b] = await Promise.all([
      adapter.extractSurface({
        name: 'synthetic',
        version: '1.0.0',
        dir: resolve(ROOT, 'synthetic'),
      }),
      adapter.extractSurface({
        name: 'synthetic',
        version: '2.0.0',
        dir: resolve(ROOT, 'synthetic-v2'),
      }),
    ]);
    const changes = diffSurfaces(a, b);
    const consumer = { dir: resolve(ROOT, 'repos/synthetic-consumer') };
    const { usages: signalA } = await adapter.findUsages(consumer, 'synthetic', a);
    const signalB = await adapter.compileAgainst?.(
      consumer,
      'synthetic',
      resolve(ROOT, 'synthetic-v2'),
    );
    const { usages, unattributed } = mergeSignals(signalA, signalB, a);
    expect(unattributed).toEqual([]);
    const findings = match(changes, usages);
    // Signal B confirms the one call the compiler rejects; nothing is inferred-only here.
    const confirmed = findings.filter((f) => f.usage.compileError !== undefined);
    expect(
      confirmed.map(
        (f) => `${f.usage.file}:${f.usage.line} ${f.change.path} :: ${f.usage.compileError}`,
      ),
    ).toEqual(['src/chains.ts:6 makeClient :: Expected 2 arguments, but got 1.']);
    expect(findings.every((f) => f.usage.via !== 'inferred')).toBe(true);
    const rows = findings.map(
      (f) =>
        `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.change.kind} ${f.severity} ${f.fixability}`,
    );
    // createClient gained a required parameter: the makeClient() call breaks through canonicalPath,
    // reported once under the name the consumer wrote, and not on the import line.
    expect(rows).toContain('src/chains.ts:6 makeClient signature breaking assisted');
    expect(rows.filter((r) => r.startsWith('src/chains.ts:6'))).toHaveLength(1);
    expect(rows.some((r) => r.startsWith('src/chains.ts:1'))).toBe(false);
    // mode was widened: writing it is fine, reading it is not.
    expect(rows).toContain('src/direct.ts:13 ParseOptions#mode widened breaking assisted');
    expect(rows).toContain('src/direct.ts:11 ParseOptions#mode widened additive none');
    // A callback the consumer implements that RECEIVES options and reads `mode`: breaking.
    expect(rows).toContain('src/callbacks.ts:13 ParseOptions#mode widened breaking assisted');
    // A callback the consumer implements that RETURNS options: `mode` is written, additive.
    expect(rows).toContain('src/callbacks.ts:16 ParseOptions#mode widened additive none');
    // VERSION is deprecated with a bare replacement: mechanical.
    expect(rows).toContain('src/direct.ts:13 VERSION deprecated deprecated mechanical');
    // Removed symbols the consumer never used produce nothing.
    expect(
      rows.some(
        (r) => r.includes('parseLegacy') || r.includes('Parser#reset') || r.includes('legacyId'),
      ),
    ).toBe(false);
    expect(findings.filter((f) => f.severity === 'breaking')).toHaveLength(3);
  });
});

describe('one finding per site for a removed container', () => {
  it('reports the outermost removed ancestor once, not every member path on the same site', () => {
    const changes = [
      change({ path: 'sharp', kind: 'removed', severity: 'breaking' }),
      change({ path: 'sharp.ResizeOptions', kind: 'removed', severity: 'breaking' }),
      change({ path: 'sharp.ResizeOptions#width', kind: 'removed', severity: 'breaking' }),
    ];
    const out = match(changes, [usage('sharp.ResizeOptions#width', 'write')]);
    expect(out.map((f) => f.change.path)).toEqual(['sharp']);
  });

  it('a deprecation applies to the name the consumer wrote, not to its alias target', () => {
    const deprecated = change({ path: 'TypeOf', kind: 'deprecated', severity: 'deprecated' });
    const viaAlias = usage('infer', 'read', 'direct', { canonicalPath: 'TypeOf' });
    expect(match([deprecated], [viaAlias])).toEqual([]);
    expect(match([deprecated], [usage('TypeOf', 'read')])).toHaveLength(1);
  });
});

describe('span-level confirmation', () => {
  it('a diagnostic confirms only the innermost usage containing it; the rest of the line stays info', () => {
    // webhook.ts:14 in a real repo: `url: z.string().trim().url()`, error under `url`.
    const changes = [
      change({
        path: 'ZodString#trim',
        kind: 'signature',
        severity: 'breaking',
        evidence: 'checker',
      }),
      change({
        path: 'ZodString#url',
        kind: 'signature',
        severity: 'breaking',
        evidence: 'checker',
      }),
      change({ path: 'ZodString#url', kind: 'deprecated', severity: 'deprecated' }),
      change({ path: 'string', kind: 'signature', severity: 'breaking', evidence: 'checker' }),
    ];
    const at = (path: string, column: number, endColumn: number): Usage =>
      usage(path, 'call', 'direct', { line: 14, column, endColumn, endLine: 14 });
    const usages = [
      at('string', 12, 18),
      at('ZodString#trim', 21, 25),
      at('ZodString#url', 28, 31),
    ];
    const signal: CompileSignal = {
      diagnostics: [
        {
          file: 'src/a.ts',
          line: 14,
          column: 28,
          endLine: 14,
          endColumn: 33,
          code: 2769,
          message: 'No overload matches this call.',
          snippet: '',
        },
      ],
      baselineErrors: 0,
      unresolvedInTarget: [],
      unresolvedFiles: [],
      linkedDependencies: [],
      unsatisfiedDependencies: [],
      timing: { baselineMs: 0, overlayMs: 0, dependenciesMs: 0 },
    };
    const surface: ApiSurface = {
      package: 'zod',
      version: '3',
      extractedAt: '',
      adapter: 'typescript',
      symbols: [],
    };
    const merged = mergeSignals(usages, signal, surface, new Set(changes.map((c) => c.path)));
    expect(merged.usages.filter((u) => u.compileError).map((u) => u.symbolPath)).toEqual([
      'ZodString#url',
    ]);
    const out = match(changes, merged.usages, { compiled: true });
    const breaking = out.filter((f) => f.severity === 'breaking');
    expect(breaking.map((f) => `${f.change.path} ${f.change.kind}`)).toEqual([
      'ZodString#url signature',
    ]);
    expect(
      out
        .filter((f) => f.severity === 'info')
        .map((f) => f.change.path)
        .sort(),
    ).toEqual(['ZodString#trim', 'string']);
    expect(out.filter((f) => f.severity === 'deprecated')).toHaveLength(1);
  });
});

describe('changes reach a usage through the types its signature names', () => {
  it('a narrowed alias breaks a write to the property declared with it', () => {
    const narrowed = change({
      path: 'Stripe.LatestApiVersion',
      kind: 'narrowed',
      severity: 'breaking',
      evidence: 'checker',
    });
    const write = usage('Stripe.StripeConfig#apiVersion', 'write');
    const out = match([narrowed], [write], {
      references: new Map([['Stripe.StripeConfig#apiVersion', ['Stripe.LatestApiVersion']]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: 'breaking',
      change: { path: 'Stripe.LatestApiVersion' },
    });
    expect(out[0]?.reason).toMatch(
      /^Stripe\.LatestApiVersion, the type of Stripe\.StripeConfig#apiVersion, /,
    );
    expect(match([narrowed], [write])).toEqual([]);
  });
});

describe('files the repository does not type-check', () => {
  it('leaves the verdict to the runtime arbiter instead of the compiler', () => {
    const removed = change({ path: 'fromBuffer', kind: 'removed', severity: 'breaking' });
    const js = usage('fromBuffer', 'call', 'direct', { checked: false, loader: 'require' });
    expect(match([removed], [js], { compiled: true })[0]?.severity).toBe('breaking');
    expect(match([removed], [usage('fromBuffer', 'call')], { compiled: true })[0]?.severity).toBe(
      'info',
    );
  });
});

describe('module-format changes reach require() sites', () => {
  const esmOnly = change({
    path: '.',
    kind: 'module-format',
    severity: 'breaking',
    notes:
      'no longer loadable with require(): "type": "module" and no require condition in exports; Node >=22 does not guarantee require(esm) (needs 22.12+ or 20.19+)',
    requireEsm: 'no',
  });
  it('breaks every require() site and leaves import sites alone, one finding per file', () => {
    const viaRequire = usage('fromBuffer', 'call', 'direct', { loader: 'require', checked: false });
    const bound = usage('.', 'import', 'require', { loader: 'require', line: 2 });
    const elsewhere = usage('.', 'import', 'require', { loader: 'require', file: 'src/b.ts' });
    const esm = usage('fromBuffer', 'call');
    const out = match([esmOnly], [viaRequire, bound, elsewhere, esm], { compiled: true });
    // Switching a file to import() is one unit of work: the file's sites ride on one finding.
    expect(
      out.map((f) => `${f.usage.file} ${f.usage.symbolPath} ${f.severity} ${f.fixability}`),
    ).toEqual(['src/a.ts fromBuffer breaking assisted', 'src/b.ts . breaking assisted']);
    expect(out[0]?.sites?.map((s) => s.line)).toEqual([1, 2]);
    expect(out[0]?.reason).toMatch(/^no longer loadable with require\(\)/);
  });
  it('with require(esm) available, judges each site by export shape', () => {
    const supported = { ...esmOnly, requireEsm: 'yes' as const, loadRoot: 'default' };
    const named = usage('fromBuffer', 'call', 'direct', { loader: 'require' });
    const onDefault = usage('default#helper', 'call', 'require', { loader: 'require' });
    const rootCall = usage('default', 'call', 'require', { loader: 'require' });
    const binding = usage('.', 'import', 'require', { loader: 'require' });
    const out = match([supported], [named, onDefault, rootCall, binding], {
      esmNamed: new Set(['fromBuffer', 'default']),
    });
    expect(out.map((f) => `${f.usage.symbolPath} ${f.severity}`)).toEqual([
      'default#helper breaking',
      'default breaking',
    ]);
    expect(out[0]?.reason).toMatch(/lives on the default export/);
    expect(out[1]?.reason).toMatch(
      /not a function or class; use require\('[^']+'\)\.default or import\(\)/,
    );
    const tla = match([{ ...supported, topLevelAwait: true }], [named]);
    expect(tla[0]).toMatchObject({ severity: 'breaking' });
    expect(tla[0]?.reason).toMatch(/throws at load time/);
    const unknown = match([{ ...esmOnly, requireEsm: 'unknown' as const }], [named, binding]);
    expect(unknown.map((f) => f.severity)).toEqual(['unverified']);
  });
  it('judges by what require() of the target really returned when Signal C observed it', () => {
    const supported = { ...esmOnly, requireEsm: 'yes' as const, loadRoot: 'default' };
    const named = usage('fromBuffer', 'call', 'direct', { loader: 'require' });
    const onDefault = usage('default#helper', 'call', 'require', { loader: 'require' });
    const rootCall = usage('default', 'call', 'require', { loader: 'require' });
    const binding = usage('.', 'import', 'require', { loader: 'require' });
    // The namespace: `fromBuffer` is on it, `helper` only on the default export.
    const namespace = {
      ok: true,
      kind: 'object',
      keys: { fromBuffer: 'function', default: 'function' },
      defaultKind: 'function',
      defaultCallable: true,
      defaultKeys: ['helper'],
    };
    const out = match([supported], [named, onDefault, rootCall, binding], {
      // Types that would have said otherwise are outranked by the observation.
      esmNamed: new Set(['default']),
      targetRequire: namespace,
    });
    expect(out.map((f) => `${f.usage.symbolPath} ${f.severity}`)).toEqual([
      'default#helper breaking',
      'default breaking',
    ]);
    expect(out[0]?.reason).toMatch(/not on the namespace require\('p'\) returns/);
    expect(out[1]?.reason).toMatch(/returns a namespace on the repository's Node/);
    // A throw breaks every site, whatever the Node range promised.
    const throws = match([supported], [named, binding], {
      targetRequire: { ok: false, code: 'ERR_REQUIRE_ASYNC_MODULE' },
    });
    expect(throws.map((f) => f.severity)).toEqual(['breaking']);
    expect(throws[0]?.reason).toMatch(
      /throws ERR_REQUIRE_ASYNC_MODULE on the repository's Node \(top-level await\)/,
    );
    // It still returned a function (a CommonJS wrapper the manifest did not show): no site breaks.
    const callable = match([supported], [named, rootCall], {
      targetRequire: {
        ok: true,
        kind: 'function',
        callable: true,
        keys: { fromBuffer: 'function' },
      },
    });
    expect(callable).toEqual([]);
  });
});

describe('a removed name is the whole story for its site', () => {
  it('drops the alias container and referenced-type findings once the written name is removed', () => {
    const changes = [
      change({ path: 'fromBuffer', kind: 'removed', severity: 'breaking' }),
      change({ path: 'core', kind: 'removed', severity: 'breaking' }),
      change({ path: 'FileTypeResult', kind: 'type', severity: 'breaking', evidence: 'checker' }),
    ];
    const site = usage('fromBuffer', 'call', 'direct', {
      canonicalPath: 'core.fromBuffer',
      checked: false,
    });
    const out = match(changes, [site], {
      compiled: true,
      references: new Map([['fromBuffer', ['FileTypeResult']]]),
    });
    expect(out.map((f) => f.change.path)).toEqual(['fromBuffer']);
  });
});

describe('a removed re-export container is no removal where the name still exists', () => {
  it('skips the inherited `core removed` when the written top-level symbol survives in the target', () => {
    const core = change({ path: 'core', kind: 'removed', severity: 'breaking' });
    // `contentType.mime`: written as `FileTypeResult#mime`, resolved through `core.FileTypeResult#mime`.
    const field = usage('FileTypeResult#mime', 'read', 'alias', {
      canonicalPath: 'core.FileTypeResult#mime',
      loader: 'require',
    });
    const stillThere = new Set(['FileTypeResult', 'FileTypeResult#mime', 'fromBuffer']);
    expect(match([core], [field], { targetPaths: stillThere })).toEqual([]);
    // Written through the container itself (`core.FileTypeResult#mime`, no alias): same answer.
    const direct = usage('core.FileTypeResult#mime', 'read', 'direct', { loader: 'require' });
    expect(match([core], [direct], { targetPaths: stillThere })).toEqual([]);
    expect(match([core], [direct], { targetPaths: new Set(['fromBuffer']) })).toHaveLength(1);
    // Gone from the top level too: the container's removal is the news.
    expect(match([core], [field], { targetPaths: new Set(['fromBuffer']) })).toHaveLength(1);
    // Without the target's paths the rule does not apply.
    expect(match([core], [field])).toHaveLength(1);
  });
});

describe('one site, one root cause', () => {
  it('collapses several removed symbols at the same line into one finding listing them', () => {
    const changes = ['a', 'b', 'c'].map((path) =>
      change({ path, kind: 'removed', severity: 'breaking' }),
    );
    const at13 = (path: string, column: number) =>
      usage(path, 'import', 'direct', { line: 13, column, endColumn: column + 1, endLine: 13 });
    const out = match(changes, [
      at13('a', 9),
      at13('b', 12),
      at13('c', 15),
      usage('a', 'call', 'direct', { line: 40 }),
    ]);
    expect(out.map((f) => `${f.usage.line} ${f.change.path} ${f.reason}`)).toEqual([
      '13 a 3 symbols removed at this site: a, b, c',
      '40 a removed',
    ]);
  });
});
