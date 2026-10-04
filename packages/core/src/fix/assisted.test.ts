import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, ts } from 'ts-morph';
import { afterAll, expect, it } from 'vitest';
import { KEY_ENV } from '../llm/config.js';
import { providerFixer } from '../llm/fixer.js';
import { DEFAULT_MODELS } from '../llm/pricing.js';
import { PROVIDERS } from '../llm/types.js';
import { zodPack } from '../packs/zod/index.js';
import { anthropicFixer } from './anthropic.js';
import { assist, enclosingContext } from './assisted.js';
import { applyFilePatch } from './patch.js';
import { git } from './process.js';
import type { FixDiagnostic, FixRequest, FixSite } from './types.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-assist-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const root = mkdtempSync(join(scratch, 'case-'));
  mkdirSync(join(root, 'src'));
  const source = 'export const n: number = "bad";\n';
  writeFileSync(join(root, 'src/a.ts'), source);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  const sites: FixSite[] = [
    {
      outcome: 'manual',
      reason: 'generic changed',
      finding: {
        change: {
          package: 'zod',
          from: '3.25.76',
          to: '4.6.5',
          path: 'ZodType',
          kind: 'type',
          severity: 'breaking',
          source: 'types',
          confidence: 1,
        },
        usage: {
          file: 'src/a.ts',
          line: 1,
          column: 14,
          endLine: 1,
          endColumn: 15,
          symbolPath: 'ZodType',
          access: 'typeRef',
          via: 'direct',
          snippet: source,
          compileCode: 2322,
        },
        severity: 'breaking',
        confidence: 1,
        fixability: 'assisted',
        reason: '',
      },
    },
  ];
  const verify = (): FixDiagnostic[] => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
    const file = project.createSourceFile('a.ts', readFileSync(join(root, 'src/a.ts'), 'utf8'));
    return project
      .getPreEmitDiagnostics()
      .filter((d) => d.getSourceFile() === file)
      .map((d) => ({
        file: 'src/a.ts',
        line: 1,
        column: 1,
        code: d.getCode(),
        message: ts.flattenDiagnosticMessageText(d.compilerObject.messageText, '\n'),
      }));
  };
  return { root, source, sites, verify };
}
const patch = (value: string) =>
  `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const n: number = "bad";\n+export const n: number = ${value};\n`;
it('keeps and commits an assisted edit only when real compiler diagnostics improve with no new error', async () => {
  const f = fixture();
  const requests: FixRequest[] = [];
  const llm = await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'mock',
      estimate: () => 0,
      fix: async (r) => {
        requests.push(r);
        return { diff: patch('42'), inputTokens: 10, outputTokens: 5, costUsd: 0.01 };
      },
    },
    f.verify,
  );
  expect(f.verify()).toEqual([]);
  expect(f.sites[0]?.outcome).toBe('agent');
  expect(f.sites[0]?.diff).toBe(patch('42'));
  expect(f.sites[0]?.attempts?.[0]?.diff).toBe(patch('42'));
  expect(llm.inputTokens).toBe(10);
  expect(f.sites[0]?.attempts?.[0]).toMatchObject({
    attempt: 1,
    outcome: 'accepted',
    inputTokens: 10,
    outputTokens: 5,
  });
  expect(f.sites[0]?.attempts?.[0]?.after).toEqual([]);
  expect(git(f.root, 'log', '-1', '--format=%s')).toContain('src/a.ts:1');
  expect(requests[0]?.compilerError).toContain('TS2322');
}, 15000);
it('reverts rejected changes, feeds back errors, and stops after two retries', async () => {
  const f = fixture();
  const requests: FixRequest[] = [];
  await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'mock',
      estimate: () => 0,
      fix: async (r) => {
        requests.push(r);
        return { diff: patch('false'), inputTokens: 1, outputTokens: 1 };
      },
    },
    f.verify,
  );
  expect(requests).toHaveLength(3);
  expect(f.sites[0]?.attempts?.map((a) => a.outcome)).toEqual(['reverted', 'reverted', 'reverted']);
  expect(requests[1]?.retry).toContain('newErrors');
  expect(f.sites[0]?.outcome).toBe('manual');
  expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe(f.source);
  expect(git(f.root, 'status', '--porcelain')).toBe('');
}, 15000);
it('rejects paths, additional files, fuzzy context and diagnostic suppression', () => {
  const source = 'export const n: number = "bad";\n';
  expect(() =>
    applyFilePatch(source, 'src/a.ts', patch('42').replaceAll('src/a.ts', '../outside.ts')),
  ).toThrow();
  expect(() => applyFilePatch(source, 'src/a.ts', patch('42') + patch('43'))).toThrow();
  expect(() => applyFilePatch('different\n', 'src/a.ts', patch('42'))).toThrow('context');
  expect(() => applyFilePatch(source, 'src/a.ts', patch('"bad" as any'))).toThrow('suppression');
  // The agent may never add these, in any file; the one cast through
  // unknown a run writes is the pack's rule for a cast the test already had.
  for (const hidden of ['"bad" as unknown as number', '1; // @ts-expect-error'])
    expect(() => applyFilePatch(source, 'src/a.ts', patch(hidden))).toThrow('suppression');
});
it('Anthropic sends only scoped context, reports usage/cost, and is absent without a key', async () => {
  expect(anthropicFixer('')).toBeUndefined();
  let sent = '';
  const mock: typeof fetch = async (_url, options) => {
    sent = String(options?.body);
    return new Response(
      JSON.stringify({
        content: [
          {
            type: 'tool_use',
            name: 'submit_patch',
            input: { diff: patch('42'), explanation: 'numeric output' },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
  };
  const fixer = anthropicFixer('test-key', mock);
  const f = fixture();
  const response = await fixer?.fix({
    finding: (f.sites[0] as FixSite).finding,
    guide: 'checked-in guide',
    source: 'unrelated private source must not be sent',
    enclosingFunction: 'const n = "bad";',
    compilerError: 'TS2322',
  });
  expect(sent).not.toContain('unrelated private source');
  expect(sent).toContain('checked-in guide');
  expect(response?.costUsd).toBeCloseTo(0.0006);
});

it('never chooses an unrelated diagnostic elsewhere in the file', async () => {
  const f = fixture();
  (f.sites[0] as FixSite).finding.usage.line = 200;
  (f.sites[0] as FixSite).finding.usage.snippet = 'unrelated';
  let called = false;
  await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'mock',
      estimate: () => 0,
      fix: async () => {
        called = true;
        return { diff: patch('42'), inputTokens: 0, outputTokens: 0 };
      },
    },
    f.verify,
  );
  expect(called).toBe(false);
  expect(f.sites[0]?.outcome).toBe('manual');
});

it('accepts structured tool output and preserves leading indentation in scoped context', async () => {
  const f = fixture();
  const mock: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        content: [
          {
            type: 'tool_use',
            name: 'submit_patch',
            input: { diff: patch('42'), explanation: 'preserve the numeric output' },
          },
        ],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    );
  const response = await anthropicFixer('test', mock)?.fix({
    finding: (f.sites[0] as FixSite).finding,
    guide: 'g',
    source: f.source,
    enclosingFunction: 'context',
    compilerError: 'error',
  });
  expect(response?.diff).toBe(patch('42'));
  expect(response?.explanation).toBe('preserve the numeric output');
});

it('repairs only hunk arithmetic with unique exact text, never fuzzy or ambiguous source', () => {
  const source = 'const a = 1;\nconst b = 2;\n';
  const diff =
    '--- a/a.ts\n+++ b/a.ts\n@@ -99,7 +99,9 @@\n-const b = 2;\n+// Single-item assumption\n+const b = 3;\n';
  expect(applyFilePatch(source, 'a.ts', diff)).toBe(
    'const a = 1;\n// Single-item assumption\nconst b = 3;\n',
  );
  expect(() => applyFilePatch('const b = 2;\nconst b = 2;\n', 'a.ts', diff)).toThrow('uniquely');
  expect(() => applyFilePatch('const b=2;\n', 'a.ts', diff)).toThrow('context');
  // A replacement written as an insertion: the old line kept as context, the new one added,
  // the header saying nothing grew. One added line means that context line; more is refused.
  expect(
    applyFilePatch(
      source,
      'a.ts',
      '--- a/a.ts\n+++ b/a.ts\n@@ -2,1 +2,1 @@\n const b = 2;\n+const b = 2 as const;\n',
    ),
  ).toBe('const a = 1;\nconst b = 2 as const;\n');
  expect(() =>
    applyFilePatch(
      source,
      'a.ts',
      '--- a/a.ts\n+++ b/a.ts\n@@ -2,1 +2,1 @@\n const b = 2;\n+const b = 2 as const;\n+const c = 3;\n',
    ),
  ).toThrow('needs its `-` line');
  // A blank context line the file does not have (the model saw the pieces apart): dropped.
  expect(
    applyFilePatch(
      'import { a } from "x";\nimport b from "y";\n',
      'a.ts',
      '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-import { a } from "x";\n+import { a, c } from "x";\n \n import b from "y";\n',
    ),
  ).toBe('import { a, c } from "x";\nimport b from "y";\n');
  // Quotes escaped once more than JSON needs: the source has plain quotes, so do the lines.
  expect(
    applyFilePatch(
      'const s = { k: "now" };\n',
      'a.ts',
      '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const s = { k: \\"now\\" };\n+const s = { k: \\"now\\" as const };\n',
    ),
  ).toBe('const s = { k: "now" as const };\n');
});

it("shows the import of a shared helper's module next to the enclosing function", () => {
  const source = [
    'import { prisma, getStripeOrThrow } from "@acme/core";',
    'import { other } from "./other";',
    '',
    'export async function GET() {',
    '  const sub = await getStripeOrThrow().subscriptions.retrieve("sub");',
    '  return sub.current_period_end;',
    '}',
    '',
  ].join('\n');
  expect(enclosingContext(source, 6, 14)).not.toContain('@acme/core');
  const shown = enclosingContext(source, 6, 14, ['@acme/core']);
  expect(shown).toContain('import { prisma, getStripeOrThrow } from "@acme/core";');
  expect(shown).not.toContain('./other');
});

it('shows where an import is used when the site is the import itself', () => {
  const source = [
    "import { lorelei } from 'styles';",
    "import { createAvatar } from 'avatars';",
    '',
    'const unrelated = 1;',
    '',
    'export function Avatar(seed: string) {',
    '  return createAvatar(lorelei, { seed }).toDataUri();',
    '}',
    '',
  ].join('\n');
  const shown = enclosingContext(source, 2, 10);
  expect(shown).toContain("Lines 2-2:\nimport { createAvatar } from 'avatars';");
  expect(shown).toContain('Lines 6-8:\nexport function Avatar(seed: string) {');
  expect(shown).not.toContain('unrelated');
});

it('preflights every retry, feeds invalid-tool feedback back, and never exceeds the budget', async () => {
  const f = fixture();
  const requests: FixRequest[] = [];
  const llm = await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'budgeted',
      estimate: () => 0.6,
      fix: async (request) => {
        requests.push(request);
        return {
          diff: '',
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.3,
          failure: 'Missing or invalid submit_patch',
        };
      },
    },
    f.verify,
    undefined,
    false,
    undefined,
    { maxCostUsd: 1 },
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]?.retry).toContain('Missing or invalid submit_patch');
  expect(llm.costUsd).toBe(0.6);
  expect(llm.costLimit).toEqual({ limitUsd: 1, notAttempted: 1 });
  expect(f.sites[0]?.outcome).toBe('manual');
  expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe(f.source);
}, 15000);

it('does not release a reservation when the API fails without reporting usage', async () => {
  const f = fixture();
  let calls = 0;
  const llm = await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'uncertain',
      estimate: () => 0.6,
      fix: async () => {
        calls++;
        return {
          diff: '',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          unreportedCostUsd: 0.6,
          failure: 'No usage returned',
        };
      },
    },
    f.verify,
  );
  expect(calls).toBe(1);
  expect(llm).toMatchObject({
    costUsd: 0,
    unreportedCostUsd: 0.6,
    costLimit: { limitUsd: 1, notAttempted: 1 },
  });
}, 15000);

it('fails closed for custom fixers without a worst-case estimate', async () => {
  const f = fixture();
  let calls = 0;
  await assist(
    f.root,
    f.sites,
    zodPack,
    {
      id: 'unbounded',
      fix: async () => {
        calls++;
        return { diff: '', inputTokens: 0, outputTokens: 0 };
      },
    },
    f.verify,
  );
  expect(calls).toBe(0);
  expect(f.sites[0]?.reason).toContain('no worst-case estimate');
});

for (const provider of PROVIDERS) {
  it(`${provider} recorded protocol response passes the real compiler and patch gate`, async () => {
    const f = fixture();
    const fixtureJson = readFileSync(
      new URL(`../llm/fixtures/${provider}.json`, import.meta.url),
      'utf8',
    );
    const fixer = providerFixer(
      { provider, model: DEFAULT_MODELS[provider], available: true },
      { env: { [KEY_ENV[provider]]: 'test-only' }, fetch: async () => new Response(fixtureJson) },
    );
    const llm = await assist(f.root, f.sites, zodPack, fixer, f.verify);
    expect(f.verify()).toEqual([]);
    expect(f.sites[0]?.outcome).toBe('agent');
    expect(llm.provider).toBe(provider);
    expect(llm.costUsd).toBeGreaterThan(0);
    expect(llm.costUsd).toBeLessThan(1);
  }, 15000);
}
