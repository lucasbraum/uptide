import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { Finding, PackageReport } from '../../domain/report.js';
import { planPackage } from '../../fix/plan.js';
import { fixtureFinding, parseMarkers, runFixtures } from '../tooling/fixtures.js';
import { reactPack } from './index.js';

it('react: every fixture rewrites and detects exactly its marked sites', () => {
  const result = runFixtures(reactPack, fileURLToPath(new URL('.', import.meta.url)));
  expect(result.cases.length).toBeGreaterThan(0);
  expect(result.unknown).toEqual([]);
  expect(result.rewriteFailures).toEqual([]);
  expect(result.falsePositives).toEqual([]);
  expect(result.falseNegatives).toEqual([]);
});

function unassignedFixtures(name: string) {
  const file = `fixtures/${name}/before.ts`;
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  return parseMarkers(text, name, file).map((site) => {
    const finding = fixtureFinding(reactPack, site, text);
    // Checker's findings have no rule ID: assigning one bypasses the matcher entirely.
    delete finding.rule;
    finding.evidence = 'compiler';
    finding.change.evidence = 'checker';
    return { site, finding, text };
  });
}

function plan(finding: Finding, text: string) {
  const pkg: PackageReport = {
    workspace: '.',
    name: 'react',
    installed: '18.3.1',
    latest: '19.3.0',
    target: '19.3.0',
    majorsBehind: 1,
    findings: [finding],
    callSitesChecked: 1,
    unanalyzed: [],
    status: 'breaking',
    notes: [],
    timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  };
  return planPackage(pkg, reactPack, () => text);
}

const context = { from: '18.3.1', to: '19.3.0', includeDeprecated: false };

it('react: unassigned useRef signature findings are planned and rewritten by the rule', () => {
  const fixtures = unassignedFixtures('use-ref-argument');
  const first = fixtures[0];
  assert(first);
  let text = first.text;
  for (const { site, finding } of fixtures.toReversed()) {
    // A real useRef signature is declared by @types/react, consumed through react.
    finding.change.package = '@types/react';
    finding.usage.package = 'react';
    finding.usage.compileCode = 2554;
    expect(reactPack.ruleOf?.(finding)).toBe('use-ref-argument');
    expect(plan(finding, text)[0]).toMatchObject({
      rule: 'use-ref-argument',
      by: { rule: site.keep ? 0 : 1, agent: site.keep ? 1 : 0, manual: 0 },
    });
    const result = reactPack.transform(text, finding, context);
    expect(result.applied).toBe(!site.keep);
    text = result.text;
  }
  expect(text).toBe(
    readFileSync(new URL('fixtures/use-ref-argument/after.ts', import.meta.url), 'utf8'),
  );
});

it.each([
  ['".":useRef', undefined],
  ['".":useRef', 'Expected 2 arguments, but got 0.'],
  ['".":useRef', 'Expected 1 arguments, but got 2.'],
  ['".":otherHook', 'Expected 1 arguments, but got 0.'],
])('react: does not claim %s without the matching diagnostic (%s)', (path, message) => {
  const first = unassignedFixtures('use-ref-argument')[0];
  assert(first);
  const { finding, text } = first;
  finding.change.path = path;
  finding.usage.compileError = message;
  expect(reactPack.ruleOf?.(finding)).toBeUndefined();
  expect(reactPack.transform(text, finding, context).applied).toBe(false);
});

it('react: only the missing JSX namespace is an agent finding, with no rewrite', () => {
  for (const { site, finding, text } of unassignedFixtures('global-jsx-namespace')) {
    finding.usage.access = 'read';
    finding.usage.via = 'inferred';
    expect(reactPack.ruleOf?.(finding)).toBe(site.keep ? undefined : 'global-jsx-namespace');
    expect(reactPack.transform(text, finding, context)).toMatchObject({ text, applied: false });
    if (!site.keep) {
      expect(plan(finding, text)[0]).toMatchObject({
        rule: 'global-jsx-namespace',
        by: { rule: 0, agent: 1, manual: 0 },
      });
      expect(reactPack.guide(finding)).toContain('import type { JSX } from "react"');
    }
  }
});

it.each([
  [2503, undefined, false],
  [2741, "Property 'children' is missing in type '{}' but required in type 'Props'.", true],
  [2746, "This JSX tag's 'children' prop expects a single child.", true],
  [2786, "'Example' cannot be used as a JSX component.", true],
  [7026, "JSX element implicitly has type 'any'.", true],
])('react: preserves JSX diagnostic matching for TS%s (%s)', (code, message, matches) => {
  const first = unassignedFixtures('global-jsx-namespace')[0];
  assert(first);
  const { finding } = first;
  finding.change.path = `TS${code}`;
  finding.usage.compileError = message;
  expect(reactPack.ruleOf?.(finding)).toBe(matches ? 'global-jsx-namespace' : undefined);
});
