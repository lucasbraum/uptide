import { describe, expect, it } from 'vitest';
import {
  type Advisory,
  deprecatedSignal,
  effortOf,
  type PackageSignals,
  prioritize,
  rankPriorities,
  reasonOf,
  securitySignal,
  unsupportedSignal,
  urgencyOf,
} from './priorities.js';

const advisory = (severity: string, vulnerable_versions: string): Advisory => ({
  severity,
  vulnerable_versions,
  title: 't',
  url: 'https://github.com/advisories/x',
});
const base: PackageSignals = { behind: 1, effort: 1 };

describe('security', () => {
  it('counts the advisories covering the installed version and finds the smallest fix', () => {
    const signal = securitySignal(
      '3.1.0',
      [
        advisory('high', '<3.1.2'),
        advisory('moderate', '>=3.0.0 <3.1.1'),
        advisory('low', '<2.0.0'),
      ],
      ['3.0.0', '3.1.0', '3.1.1', '3.1.2', '3.2.0-beta.1', '4.0.0'],
    );
    expect(signal).toEqual({
      advisories: 2,
      worst: 'high',
      counts: { high: 1, moderate: 1 },
      fixedIn: '3.1.2',
      fixChange: 'patch',
    });
    expect(reasonOf({ ...base, security: signal }, '3.1.0', 4)).toBe(
      '2 advisories (1 high), fixed in 3.1.2 (patch, same major)',
    );
  });
  // Ranges recorded from npm's bulk advisory endpoint (fixtures/repos/list-accuracy/priorities).
  it('says when the smallest fix stays in the major and when it needs a new one', () => {
    const lodash = securitySignal(
      '4.17.15',
      [
        advisory('high', '<4.17.21'),
        advisory('high', '>=3.7.0 <4.17.19'),
        advisory('moderate', '>=4.0.0 <4.17.21'),
        advisory('moderate', '>=4.0.0 <=4.17.22'),
        advisory('high', '>=4.0.0 <=4.17.23'),
        advisory('moderate', '<=4.17.23'),
      ],
      ['4.17.15', '4.17.19', '4.17.21', '4.17.23', '4.18.0', '4.18.1'],
    );
    expect(reasonOf({ ...base, security: lodash }, '4.17.15', 0)).toBe(
      '6 advisories (3 high), fixed in 4.18.0 (minor, same major)',
    );
    const jwt = securitySignal(
      '8.5.1',
      [
        advisory('moderate', '<9.0.0'),
        advisory('high', '<=8.5.1'),
        advisory('moderate', '<=8.5.1'),
      ],
      ['8.5.1', '9.0.0', '9.0.3'],
    );
    expect(reasonOf({ ...base, security: jwt }, '8.5.1', 0)).toBe(
      '3 advisories (1 high), needs 9.0.0 (major)',
    );
  });
  it('is absent when no advisory covers the installed version, and says so when nothing is fixed', () => {
    expect(securitySignal('3.1.2', [advisory('high', '<3.1.2')], ['3.1.2'])).toBeUndefined();
    const open = securitySignal('1.0.0', [advisory('critical', '*')], ['1.0.0', '1.1.0']);
    expect(reasonOf({ ...base, security: open }, '1.0.0', 0)).toBe(
      '1 advisory (1 critical), no fixed version yet',
    );
  });
});

describe('runtime over dev', () => {
  const sec = (worst: 'critical' | 'high', dev = false): PackageSignals => ({
    ...base,
    ...(dev ? { dev: true } : {}),
    security: {
      advisories: 1,
      worst,
      counts: { [worst]: 1 },
      fixedIn: '1.0.1',
      fixChange: 'patch',
    },
  });
  it('drops a dev package one severity step: a dev critical ties a runtime high', () => {
    expect(urgencyOf(sec('critical'))?.urgency).toBe(5.4);
    expect(urgencyOf(sec('high'))?.urgency).toBe(5.3);
    expect(urgencyOf(sec('critical', true))?.urgency).toBe(5.3);
    expect(urgencyOf(sec('high', true))?.urgency).toBe(5.2);
  });
  it('ranks a runtime high above a dev-only critical, and says dev in the reason', () => {
    const { priorities } = prioritize(
      [
        {
          name: 'vitest',
          current: '1.0.0',
          change: 'major',
          classification: 'tooling',
          usage: { files: 0 },
          signals: sec('critical', true),
        },
        {
          name: 'express',
          current: '1.0.0',
          change: 'major',
          classification: 'used',
          usage: { files: 9 },
          signals: { ...sec('high'), effort: 9 },
        },
      ],
      [],
    );
    expect(priorities.map((p) => [p.name, p.reason])).toEqual([
      ['express', '1 advisory (1 high), fixed in 1.0.1 (patch, same major)'],
      ['vitest', 'dev · 1 advisory (1 critical), fixed in 1.0.1 (patch, same major)'],
    ]);
  });
});

describe('smallest fix', () => {
  it('ranks a same-major fix above a major-only one at equal severity, and targets the fix', () => {
    const fix = (fixedIn: string, fixChange: 'patch' | 'major'): PackageSignals => ({
      ...base,
      effort: 0,
      security: { advisories: 1, worst: 'high', counts: { high: 1 }, fixedIn, fixChange },
    });
    const { priorities } = prioritize(
      [
        {
          name: 'needs-major',
          current: '1.0.0',
          change: 'major',
          classification: 'used',
          usage: { files: 0 },
          signals: fix('2.0.0', 'major'),
        },
        {
          name: 'same-major',
          current: '1.0.0',
          change: 'major',
          classification: 'used',
          usage: { files: 0 },
          signals: { ...fix('1.0.1', 'patch'), effort: 50 },
        },
      ],
      [],
    );
    expect(priorities.map((p) => [p.name, p.sameMajorFix ?? false, p.target])).toEqual([
      ['same-major', true, 'same-major@1.0.1'],
      ['needs-major', false, 'needs-major@2.0.0'],
    ]);
  });
});

describe('deprecated', () => {
  it('keeps the registry message, collapsed to one line, and truncates it in the reason', () => {
    const message = deprecatedSignal(
      '  request has been deprecated,\n see https://github.com/request/request/issues/3142 ',
    );
    expect(message).toBe(
      'request has been deprecated, see https://github.com/request/request/issues/3142',
    );
    expect(reasonOf({ ...base, deprecated: message }, '2.88.2', 3)).toBe(
      'deprecated: request has been deprecated, see https://github.com/request…',
    );
    expect(deprecatedSignal('')).toBeUndefined();
  });
});

describe('unsupported', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const time = {
    created: '2020-01-01T00:00:00Z',
    '4.0.0': '2024-01-10T00:00:00Z',
    '4.9.2': '2025-03-04T00:00:00Z',
    '5.0.0-rc.1': '2025-09-01T00:00:00Z',
    '5.0.0': '2025-10-01T00:00:00Z',
  };
  it('flags a major line with no release for a year while a newer major exists', () => {
    expect(unsupportedSignal('4.2.0', '5.0.0', time, now)).toEqual({ since: '2025-03' });
    expect(reasonOf({ ...base, unsupported: { since: '2025-03' } }, '4.2.0', 37)).toBe(
      '4.x line unsupported since 2025-03, 37 files to touch',
    );
  });
  it('does not flag a recent line, or one with no newer major', () => {
    expect(
      unsupportedSignal('4.2.0', '5.0.0', time, new Date('2025-12-01T00:00:00Z')),
    ).toBeUndefined();
    expect(unsupportedSignal('5.0.0', '5.1.0', time, now)).toBeUndefined();
  });
});

describe('blocking', () => {
  it('names what the installed peer range holds back, or what it must move with', () => {
    expect(reasonOf({ ...base, blocks: ['ai 7'] }, '1.0.0', 0)).toBe('blocks ai 7');
    expect(reasonOf({ ...base, movesWith: ['ai'] }, '1.0.0', 0)).toBe('moves with ai');
    expect(urgencyOf({ ...base, blocks: ['ai 7'] })?.signal).toBe('blocking');
  });
});

describe('behind', () => {
  it('is a signal from two majors behind; one is the normal state of an outdated package', () => {
    expect(urgencyOf({ ...base, behind: 1 })).toBeUndefined();
    expect(urgencyOf({ ...base, behind: 2 })?.signal).toBe('behind');
    expect(reasonOf({ ...base, behind: 3 }, '1.0.0', 2)).toBe('3 majors behind, 2 files to touch');
  });
});

describe('effort', () => {
  it('costs a file 1 and ten calls 1, halved by a verified pack', () => {
    expect(effortOf({ files: 4, callSites: 20 }, false)).toBe(6);
    expect(effortOf({ files: 4, callSites: 20 }, true)).toBe(3);
    expect(effortOf({ files: 0, callSites: 0 }, false)).toBe(0);
  });
});

describe('ranking', () => {
  it('orders by urgency (security > deprecated > unsupported > blocking > behind), then effort', () => {
    const all: PackageSignals[] = [
      { ...base, behind: 3 },
      { ...base, blocks: ['x 2'] },
      { ...base, unsupported: { since: '2024-01' } },
      { ...base, deprecated: 'old' },
      { ...base, security: { advisories: 1, worst: 'low', counts: { low: 1 } } },
    ];
    expect(all.map((s) => urgencyOf(s)?.signal)).toEqual([
      'behind',
      'blocking',
      'unsupported',
      'deprecated',
      'security',
    ]);
    const row = (name: string, urgency: number, effort: number) => ({
      name,
      packages: [name],
      signal: 'behind' as const,
      urgency,
      effort,
      reason: '',
    });
    expect(
      rankPriorities([row('costly', 3, 40), row('cheap', 3, 2), row('urgent', 5.3, 90)]).map(
        (r) => r.name,
      ),
    ).toEqual(['urgent', 'cheap', 'costly']);
    // A critical advisory outranks a low one.
    const sec = (worst: 'critical' | 'low') =>
      urgencyOf({ ...base, security: { advisories: 1, worst, counts: { [worst]: 1 } } })?.urgency ??
      0;
    expect(sec('critical')).toBeGreaterThan(sec('low'));
  });
});

describe('prioritize', () => {
  const pkg = (
    name: string,
    signals: Partial<PackageSignals>,
    change: 'major' | 'minor' | 'patch' = 'major',
    files = 1,
  ) => ({
    name,
    current: '1.0.0',
    change,
    classification: 'used',
    usage: { files },
    signals: { ...base, effort: files, ...signals },
  });
  it('makes a group one row, named after the group and costed as all its members', () => {
    const lead = pkg('ai', { movesWith: ['@ai-sdk/openai'] }, 'major', 5);
    const member = pkg('@ai-sdk/openai', { deprecated: 'use v2', movesWith: ['ai'] }, 'major', 2);
    const { priorities } = prioritize(
      [lead, member],
      [
        {
          id: 'ai',
          name: 'ai + @ai-sdk/*',
          lead: 'ai',
          reason: 'shared @ai-sdk/provider',
          members: [lead, member],
        },
      ],
    );
    expect(priorities).toEqual([
      {
        name: 'ai + @ai-sdk/*',
        group: 'ai',
        packages: ['ai', '@ai-sdk/openai'],
        signal: 'deprecated',
        urgency: 4,
        effort: 7,
        reason: '@ai-sdk/openai deprecated: use v2',
      },
    ]);
  });
  it('names a member before its reason, after the dev prefix', () => {
    const lead = { ...pkg('eslint', {}), classification: 'tooling' };
    const member = {
      ...pkg('@eslint/js', { deprecated: 'use eslint/js', dev: true }),
      classification: 'tooling',
    };
    const { priorities } = prioritize(
      [lead, member],
      [{ id: 'eslint', name: 'eslint', lead: 'eslint', members: [lead, member] }],
    );
    expect(priorities[0]?.reason).toBe('dev · @eslint/js deprecated: use eslint/js');
  });

  it('does not make a group urgent only because its members move together or hold each other back', () => {
    const a = pkg('a', { movesWith: ['b'], blocks: ['b 2'] });
    const b = pkg('b', { movesWith: ['a'] });
    expect(
      prioritize([a, b], [{ id: 'a', name: 'a', reason: 'peer link', members: [a, b] }]).priorities,
    ).toEqual([]);
  });
  it('suggests cheap minor and patch upgrades as one batch when nothing is urgent', () => {
    const { priorities, cheapBatch } = prioritize(
      [
        pkg('tiny', {}, 'patch', 0),
        pkg('small', {}, 'minor', 2),
        pkg('wide', {}, 'minor', 12),
        pkg('major-one', {}, 'major', 1),
      ],
      [],
    );
    expect(priorities).toEqual([]);
    expect(cheapBatch).toEqual(['tiny', 'small']);
  });
  it('batches a group only when every member is cheap', () => {
    const a = pkg('@aws/a', {}, 'minor', 1);
    const b = pkg('@aws/b', {}, 'major', 1);
    const c = pkg('@ui/c', {}, 'patch', 0);
    const d = pkg('@ui/d', {}, 'minor', 2);
    const { cheapBatch } = prioritize(
      [a, b, c, d],
      [
        { id: 'aws', name: '@aws/*', members: [a, b] },
        { id: 'ui', name: '@ui/*', members: [c, d] },
      ],
    );
    expect(cheapBatch).toEqual(['@ui/c', '@ui/d']);
  });
});
