import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckReport } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { checkMetrics } from './metrics.js';
import { buildEvent, type Event, sanitizeEvent } from './payload.js';
import { identity } from './settings.js';

it('sends no source, paths, repository/user names, argv, secrets or unknown properties', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uptide-sensitive-project-'));
  const source = 'const secretCustomer = "do-not-send-source";';
  const raw = {
    repo,
    name: 'secret-repository',
    username: 'private-user',
    workspaces: ['packages/private-api'],
    packages: [
      {
        name: 'zod',
        installed: '3.0.0',
        target: '4.0.0',
        timing: { fetchMs: 1, diffMs: 2, usagesMs: 3, compileMs: 4 },
        findings: [
          { usage: { file: 'C:\\Users\\private-user\\repo\\source.ts', snippet: source } },
        ],
        notes: [source],
      },
      { name: '@private-company/internal', installed: '1.0.0', target: '2.0.0', timing: {} },
      { name: '@example/hidden-package', installed: '1.0.0', target: '2.0.0', timing: {} },
    ],
    summary: {
      breaking: 1,
      deprecated: 0,
      unverified: 0,
      failed: 1,
      partiallyAnalyzed: 1,
      secret: source,
    },
    code: source,
  } as unknown as CheckReport;
  const event = buildEvent(
    identity({ consent: true }),
    'check',
    '0.1.0',
    checkMetrics(raw),
    100,
    1,
    (name) => name === 'zod',
  ) as Event;
  const text = JSON.stringify(event);
  for (const forbidden of [
    repo,
    source,
    'secret-repository',
    'private-user',
    'private-api',
    '@private-company/internal',
    '@example/hidden-package',
    'C:\\Users',
    'snippet',
    'findings',
    'notes',
  ])
    expect(text).not.toContain(forbidden);
  expect(event.properties.packages).toEqual([{ name: 'zod', versions: ['3.0.0', '4.0.0'] }]);
  expect(event.properties).toMatchObject({
    $ip: null,
    $geoip_disable: true,
    $process_person_profile: false,
    verification: 'not_run',
    counts: { partial: 1 },
  });
  const unsafe = {
    ...event,
    code: source,
    properties: {
      ...event.properties,
      $ip: '203.0.113.1',
      $geoip_city_name: 'Secret City',
      $set: { name: 'private-user' },
      argv: [source],
      counts: { ...event.properties.counts, source },
      durations_ms: { total: source },
      cost_usd: Infinity,
    },
  };
  const cleaned = sanitizeEvent(unsafe, () => true) as Event;
  expect(JSON.stringify(cleaned)).not.toMatch(
    /203\.0\.113|Secret City|private-user|do-not-send-source|\$set|argv/,
  );
  expect(cleaned.properties.durations_ms.total).toBe(0);
  expect(cleaned.properties.cost_usd).toBe(0);
});

it('uses a secret per-install salt for stable, non-reversible, unlinked repository hashes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uptide-hash-'));
  const other = mkdtempSync(join(tmpdir(), 'uptide-hash-'));
  const a = identity({ consent: true }),
    b = identity({ consent: true });
  const hash = (settings: typeof a, dir: string) =>
    buildEvent(settings, 'list', '0.1.0', { repo: dir }, 1, 0, () => false)?.properties.repo_hash;
  expect(hash(a, repo)).toMatch(/^[a-f0-9]{64}$/);
  expect(hash(a, repo)).toBe(hash(a, repo));
  expect(hash(a, other)).not.toBe(hash(a, repo));
  expect(hash(b, repo)).not.toBe(hash(a, repo));
  expect(JSON.stringify(buildEvent(a, 'list', '0.1.0', { repo }, 1, 0, () => false))).not.toContain(
    a.salt,
  );
});

it('rejects path-like package/version/command fields before asking for public evidence', () => {
  const base = buildEvent(
    identity({ consent: true }),
    'check',
    '0.1.0',
    {},
    1,
    0,
    () => false,
  ) as Event;
  const known = vi.fn(() => false);
  expect(
    sanitizeEvent(
      {
        ...base,
        properties: {
          ...base.properties,
          packages: [
            { name: '../../source', versions: ['1.0.0'] },
            {
              name: 'safe',
              versions: ['file:/secret', 'https://secret/path', 'const source = 1;'],
            },
          ],
        },
      },
      known,
    )?.properties.packages,
  ).toEqual([]);
  expect(known).not.toHaveBeenCalled();
  expect(
    sanitizeEvent({ properties: { ...base.properties, command: 'check /private/repo' } }, known),
  ).toBeUndefined();
});

it('reduces assisted fixes and verification to counts, result, durations and cost', async () => {
  const { fixReport } = await import('../test-utils.js');
  const { fixMetrics } = await import('./metrics.js');
  const repo = mkdtempSync(join(tmpdir(), 'uptide-fix-private-'));
  const report = fixReport(false);
  report.notes = ['const privateSource = "private-user";'];
  report.verification.newErrors = [
    { file: '/private/user/source.ts', message: 'private source text' },
  ] as typeof report.verification.newErrors;
  report.llm.costUsd = 0.12345678;
  report.llm.inputTokens = 123;
  report.verificationTimingMs = 42;
  const event = buildEvent(
    identity({ consent: true }),
    'fix',
    '0.1.0',
    fixMetrics(report, repo),
    100,
    1,
    () => true,
  );
  expect(event?.properties).toMatchObject({
    verification: 'failed',
    cost_usd: 0.123457,
    counts: { new_errors: 1 },
    durations_ms: { verification: 42 },
  });
  expect(JSON.stringify(event)).not.toMatch(
    /privateSource|private-user|private source text|source\.ts|inputTokens|prBody|notes/,
  );
  expect(JSON.stringify(event)).not.toContain(repo);
  report.verificationPending = true;
  expect(fixMetrics(report, repo).verification).toBe('not_run');
});
