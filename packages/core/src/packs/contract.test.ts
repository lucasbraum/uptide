import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../domain/report.js';
import {
  companionProblems,
  definePack,
  type GroundTruth,
  recordedStatus,
  replaceAtSite,
  statusOf,
  truthDigest,
} from './contract.js';
import { activePacks, registeredPacks } from './index.js';
import { runFixtures } from './tooling/fixtures.js';
import { scoreSites } from './tooling/pack-test.js';
import { parseRegistry, renderRegistry } from './tooling/registry-file.js';
import { truthProblems } from './tooling/truth.js';

const packsDir = fileURLToPath(new URL('.', import.meta.url));

describe('every registered pack meets the contract', () => {
  it('the registry file is exactly what pack new renders', () => {
    const text = readFileSync(join(packsDir, 'registry.ts'), 'utf8');
    expect(renderRegistry(parseRegistry(text))).toBe(text);
    expect(parseRegistry(text).map((e) => e.dir)).toEqual(registeredPacks().map((e) => e.dir));
  });

  it.each(registeredPacks().map((e) => [e.pack.name, e] as const))('%s', (_name, entry) => {
    const { pack } = entry;
    expect(pack.meta.package).toBe(pack.name);
    expect(pack.meta.maintainer).not.toBe('');
    expect(pack.meta.sources.length).toBeGreaterThan(0);
    for (const s of pack.meta.sources) expect(s.url).toMatch(/^https:\/\//);
    const ids = [...pack.rules.map((r) => r.id), ...pack.behavior.map((b) => b.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of pack.rules) {
      expect(rule.summary, rule.id).not.toBe('');
      expect(['breaking', 'deprecated']).toContain(rule.severity);
    }
    for (const note of pack.behavior) {
      expect(note.reported.length, note.id).toBeGreaterThan(0);
      if (note.reported.includes('finding')) expect(note.detect, note.id).toBeDefined();
    }
    expect(pack.instructions).not.toBe('');

    const dir = join(packsDir, entry.dir);
    const fixtures = runFixtures(pack, dir);
    expect(fixtures.unknown).toEqual([]);
    expect(fixtures.rewriteFailures).toEqual([]);
    expect(fixtures.falsePositives).toEqual([]);
    expect(fixtures.falseNegatives).toEqual([]);

    const file = join(dir, 'ground-truth.json');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(truthProblems(JSON.parse(text) as GroundTruth, pack.name)).toEqual([]);
    // The status the CLI shows was measured on the ground truth as committed.
    if (entry.verification.status === 'verified')
      expect(entry.verification.truth).toBe(truthDigest(text));
  });

  it('every rule that rewrites or detects has a fixture site, and one it leaves alone', () => {
    for (const { pack, dir } of registeredPacks()) {
      const before = (c: string) =>
        readFileSync(join(packsDir, dir, 'fixtures', c, 'before.ts'), 'utf8');
      const cases = runFixtures(pack, join(packsDir, dir)).cases;
      const marked = cases.map(before).join('\n');
      for (const rule of pack.rules.filter((r) => r.rewrite || r.detect)) {
        expect(marked, `${pack.name} ${rule.id}`).toMatch(
          new RegExp(`@uptide ${rule.id}(?! keep)(?:\\s|$)`),
        );
        expect(marked, `${pack.name} ${rule.id} keep`).toContain(`@uptide ${rule.id} keep`);
      }
    }
  });

  it('check, list and fix use the verified packs only', () => {
    const verified = registeredPacks()
      .filter((e) => recordedStatus(e.verification) === 'verified')
      .map((e) => e.pack.name);
    expect(activePacks().map((p) => p.name)).toEqual(verified);
  });
});

describe('the verified gate', () => {
  const truth = (repos: number, fixtures = 0): GroundTruth => ({
    package: 'x',
    repos: [
      ...Array.from({ length: repos }, (_, i) => ({
        repo: `o/r${i}`,
        commit: 'a'.repeat(40),
        from: '1.0.0',
        to: '2.0.0',
        why: '',
        findings: [],
      })),
      ...Array.from({ length: fixtures }, () => ({
        fixture: 'fixtures/repos/x',
        from: '1.0.0',
        to: '2.0.0',
        why: '',
        findings: [],
      })),
    ],
  });
  it('needs two public repositories, no breaking false positive, and something found', () => {
    expect(statusOf(truth(2), { falsePositives: 0, predicted: 3 })).toBe('verified');
    expect(statusOf(truth(1, 3), { falsePositives: 0, predicted: 3 })).toBe('candidate');
    expect(statusOf(truth(3), { falsePositives: 1, predicted: 3 })).toBe('candidate');
    expect(statusOf(truth(2), { falsePositives: 0, predicted: 0 })).toBe('candidate');
  });
  it('a record that contradicts itself is a candidate', () => {
    const record = {
      status: 'verified' as const,
      truth: 'sha256-x',
      repos: 2,
      breaking: { precision: 1, recall: 1, falsePositives: 0 },
    };
    expect(recordedStatus(record)).toBe('verified');
    expect(recordedStatus({ ...record, repos: 1 })).toBe('candidate');
    expect(recordedStatus({ ...record, breaking: { ...record.breaking, falsePositives: 2 } })).toBe(
      'candidate',
    );
    expect(recordedStatus(undefined)).toBe('candidate');
  });
});

describe('companionProblems', () => {
  const source = 'https://example.com/toy/changelog';

  it('accepts an entry with a name and an https source, and no entries at all', () => {
    expect(companionProblems(undefined, 'toy')).toEqual([]);
    expect(companionProblems([{ name: 'toy-plugin', source }], 'toy')).toEqual([]);
  });

  it('refuses an entry with no source, an empty one, or one that is not an https URL', () => {
    const problems = companionProblems(
      [
        { name: 'no-source' },
        { name: 'empty-source', source: '' },
        { name: 'plain-text', source: 'the migration guide' },
        { name: 'insecure', source: 'http://example.com/guide' },
        { name: 'local', source: 'file:///etc/hosts' },
      ],
      'toy',
    );
    expect(problems).toHaveLength(5);
    expect(problems[0]).toBe(
      'companions[0] "no-source": source must be the https URL of the official migration guide or changelog that says it moves with toy',
    );
  });

  it("refuses an entry without a name, or one that names the pack's own package", () => {
    expect(companionProblems([{ source }], 'toy')).toEqual(['companions[0]: name is empty']);
    expect(companionProblems([{ name: 'toy', source }], 'toy')).toEqual([
      'companions[0] "toy": a pack does not name its own package',
    ]);
  });
});

describe('definePack', () => {
  const finding = (line: number, column: number, rule?: string): Finding => ({
    change: {
      package: 'toy',
      from: '1.2.0',
      to: '2.0.0',
      path: 'oldName',
      kind: 'removed',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
    },
    usage: {
      file: 'a.ts',
      line,
      column,
      endLine: line,
      endColumn: column,
      symbolPath: 'oldName',
      access: 'call',
      snippet: '',
      via: 'direct',
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'mechanical',
    reason: '',
    ...(rule ? { rule } : {}),
  });
  const pack = definePack({
    meta: {
      package: 'toy',
      from: '>=1 <2',
      to: '>=2 <3',
      sources: [{ title: 'guide', url: 'https://example.com' }],
      maintainer: 'uptide-dev',
    },
    rules: [
      {
        id: 'rename',
        summary: 'oldName is newName',
        severity: 'breaking',
        kinds: ['removed'],
        symbols: /^oldName$/,
        guide: 'use newName',
        rewrite: (text, f) => replaceAtSite(text, f, 'oldName', 'newName'),
      },
    ],
    behavior: [
      {
        id: 'retry',
        summary: 'connect() retries by default',
        reported: ['finding'],
        detect: (text) =>
          text.includes('connect(') ? [{ line: 1, column: 1, snippet: 'connect()' }] : [],
      },
    ],
    instructions: 'only the site',
  });

  it('carries the packages the pack says always move with it, and none by default', () => {
    expect(pack.companions).toBeUndefined();
    const companions = [{ name: 'toy-plugin', source: 'https://example.com/toy/changelog' }];
    const named = definePack({ meta: pack.meta, rules: [], instructions: 'x', companions });
    expect(named.companions).toEqual(companions);
  });

  it('rewrites only the reported occurrence, within the supported versions', () => {
    const text = 'oldName(oldName(1));';
    const out = pack.transform(text, finding(1, 9), {
      from: '1.2.0',
      to: '2.0.0',
      includeDeprecated: false,
    });
    expect(out).toMatchObject({ applied: true, rule: 'rename', text: 'oldName(newName(1));' });
    expect(
      pack.transform(text, finding(1, 9), { from: '2.0.0', to: '3.0.0', includeDeprecated: true })
        .applied,
    ).toBe(false);
    expect(replaceAtSite('const oldNameX = 1;', finding(1, 7), 'oldName', 'newName').applied).toBe(
      false,
    );
  });

  it("reports a note's sites as the pack's own findings, in files that use the package", () => {
    const findings =
      pack.runtimeFindings?.({
        root: '/r',
        workspace: 'app',
        from: '1.2.0',
        to: '2.0.0',
        installedDir: '',
        targetDir: '',
        usages: [{ file: 'src/db.ts' } as never, { file: 'src/db.ts' } as never],
        read: (file) => (file === join('app', 'src/db.ts') ? 'connect()' : undefined),
      }) ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'retry',
      severity: 'breaking',
      fixability: 'manual',
      change: { source: 'pack', path: 'toy:retry' },
      usage: { file: 'src/db.ts', line: 1 },
    });
  });
});

describe('scoring', () => {
  it('a site at an expected line under another rule is a hit, listed as such', () => {
    const score = scoreSites(
      [
        { file: 'a.ts', line: 1, rule: 'x', severity: 'breaking' },
        { file: 'a.ts', line: 2, rule: 'y', severity: 'breaking' },
        { file: 'b.ts', line: 9, rule: 'x', severity: 'breaking' },
      ],
      [
        { file: 'a.ts', line: 1, rule: 'x' },
        { file: 'a.ts', line: 2, rule: 'x' },
        { file: 'c.ts', line: 3, rule: 'x' },
      ],
    );
    expect(score.falsePositives).toEqual([
      { file: 'b.ts', line: 9, rule: 'x', severity: 'breaking' },
    ]);
    expect(score.falseNegatives).toEqual([{ file: 'c.ts', line: 3, rule: 'x' }]);
    expect(score.wrongRule).toEqual([
      { file: 'a.ts', line: 2, rule: 'y', severity: 'breaking', expected: 'x' },
    ]);
  });
});
