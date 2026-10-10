import { describe, expect, it } from 'vitest';
import { formatFixSummary } from './format-fix.js';
import { fixReport } from './test-utils.js';

describe('formatFixSummary', () => {
  it('shows allowed and unallowed peer risks with their declared ranges', () => {
    const out = formatFixSummary({
      ...fixReport(true),
      peerConflicts: [
        {
          name: 'plugin',
          version: '1.0.0',
          peers: [
            { peer: 'react', range: '^18', target: '19.0.0', version: '1.0.0' },
            { peer: 'react-dom', range: '^18', target: '19.0.0', version: '1.0.0' },
          ],
          allowed: true,
        },
        {
          name: 'other',
          version: '1.0.0',
          peers: [{ peer: 'react', range: '^18', target: '19.0.0', version: '1.0.0' }],
          allowed: false,
        },
      ],
    });
    expect(out).toContain('Peer risks');
    expect(out).toContain(
      'plugin 1.0.0: react ^18 rejects 19.0.0; react-dom ^18 rejects 19.0.0 · explicitly allowed in package.json',
    );
    expect(out.split('\n').filter((line) => line.trim().startsWith('plugin '))).toHaveLength(1);
    expect(out).toContain('other 1.0.0: react ^18 rejects 19.0.0');
  });

  it('says the five facts, where the branch is, and the exact next commands', () => {
    const report = {
      ...fixReport(true),
      from: '14.25.0',
      target: '23.0.0',
      package: 'stripe',
      branch: 'uptide/stripe-23.0.0',
      targetSource: 'latest on npm' as const,
      timingMs: 517_000,
      source: '/home/me/acme-app',
      base: 'main',
      remote: 'https://github.com/me/acme-app',
      prBody: '/home/me/acme-app/.git/uptide/uptide__stripe-23.0.0/pr-body.md',
      html: '/home/me/acme-app/.git/uptide/uptide__stripe-23.0.0/report.html',
    };
    const out = formatFixSummary(report, {
      color: false,
      invocation: 'npx uptide@next',
      cwd: '/home/me/acme-app',
    });
    expect(out).toBe(
      [
        'uptide fix · stripe 14.25.0 → 23.0.0 (latest on npm) · verification passed · 8m 37s',
        '',
        '  Risk      Medium: no tests',
        '  Changes   none: versions and lockfile only',
        '  Types     ✅ 0 errors after the bump → 0',
        '  Behavior  ⚠️ not checked',
        '  Tests     ⚠️ no tests ran',
        '',
        'Branch uptide/stripe-23.0.0 (in your repository, not checked out)',
        '  git diff main..uptide/stripe-23.0.0 --stat',
        '',
        'Next',
        '  npx uptide@next pr --branch uptide/stripe-23.0.0      push the branch and open a draft PR on me/acme-app',
        '  open .git/uptide/uptide__stripe-23.0.0/report.html    the migration report',
        '  .git/uptide/uptide__stripe-23.0.0/pr-body.md          the PR description',
        '',
      ].join('\n'),
    );
  });

  it('points a failed run at verify, and a published one at its PR', () => {
    const failed = formatFixSummary(
      { ...fixReport(false), branch: 'uptide/zod-4.6.5' },
      { color: false },
    );
    expect(failed).toContain('verification failed');
    expect(failed).toContain('npx uptide verify --branch uptide/zod-4.6.5');
    expect(failed).not.toContain(' pr --branch');
    const published = formatFixSummary(
      { ...fixReport(true), prUrl: 'https://github.com/o/r/pull/9' },
      { color: false },
    );
    // Aligned with the other next steps, whose longest entry sets the padding.
    expect(published).toMatch(/https:\/\/github\.com\/o\/r\/pull\/9 +the pull request/);
  });
});

it('summarizes lockfile housekeeping without expanding placements in the terminal', () => {
  const report = fixReport(true);
  report.lockfile = {
    manager: 'npm',
    file: 'package-lock.json',
    added: [],
    removed: [],
    changed: [],
    allowed: [],
    housekeeping: {
      deduped: [
        {
          from: 'node_modules/a/node_modules/b',
          to: 'node_modules/b',
          name: 'b',
          version: '1.0.0',
        },
      ],
      metadata: [],
    },
  };
  const out = formatFixSummary(report, { color: false });
  expect(out).toContain('Lockfile housekeeping · 1 dedupe move · 0 metadata-only changes');
  expect(out).not.toContain('node_modules/');
});
