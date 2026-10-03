import type { Change } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { formatHuman } from './format.js';

const change = (
  c: Partial<Change> & { path: string; kind: Change['kind']; severity: Change['severity'] },
): Change => ({
  package: 'axios',
  from: '0.27.2',
  to: '1.7.0',
  source: 'types',
  confidence: 1,
  ...c,
});

const changes: Change[] = [
  change({
    path: 'AxiosError#status',
    kind: 'type',
    severity: 'breaking',
    before: 'string',
    after: 'number',
  }),
  change({ path: 'Old', kind: 'removed', severity: 'breaking', before: 'class' }),
  change({ path: 'Old#run', kind: 'removed', severity: 'breaking' }),
  change({
    path: 'legacy',
    kind: 'deprecated',
    severity: 'deprecated',
    source: 'jsdoc',
    notes: 'use modern',
  }),
  change({ path: 'modern', kind: 'added', severity: 'additive', after: '(): void' }),
  change({ path: 'Client#warn', kind: 'signature', severity: 'breaking', visibility: 'protected' }),
  change({
    path: 'gone',
    kind: 'removed',
    severity: 'breaking',
    replacement: 'here',
    confidence: 0.8,
  }),
];

describe('formatHuman', () => {
  const out = formatHuman(changes, { color: false });

  it('groups by severity in breaking, deprecated, additive order with counts', () => {
    expect(out.indexOf('BREAKING (3)')).toBeLessThan(out.indexOf('DEPRECATED (1)'));
    expect(out.indexOf('DEPRECATED (1)')).toBeLessThan(out.indexOf('ADDITIVE (1)'));
  });

  it('puts the path first, then a description, then before -> after', () => {
    expect(out).toContain('  AxiosError#status  type changed\n      string -> number');
    expect(out).toContain('  legacy  deprecated: use modern');
    expect(out).toContain('  gone  removed, possibly renamed to here (80%)');
  });

  it('hides implied members and protected symbols by default and says so', () => {
    expect(out).not.toContain('Old#run');
    expect(out).not.toContain('Client#warn');
    expect(out).toContain('2 hidden (1 members of removed symbols, 1 protected/@internal)');
  });

  it('--all shows everything', () => {
    const all = formatHuman(changes, { color: false, all: true });
    expect(all).toContain('Old#run');
    expect(all).toContain('Client#warn');
    expect(all).not.toContain('hidden');
  });

  it('says so when there is nothing to show', () => {
    expect(formatHuman([], { color: false })).toContain('no changes to the public API');
  });
});
