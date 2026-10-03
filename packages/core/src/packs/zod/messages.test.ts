import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { zodPack } from './index.js';
import { defaultMessageSites } from './messages.js';

const root = mkdtempSync(join(tmpdir(), 'zod-messages-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (file: string, lines: string[]) => {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), lines.join('\n'));
};
write('src/queue/Adapter.test.ts', [
  'it("dead-letters an invalid message", () => {',
  '  expect(deadLetter).toHaveBeenCalledWith(message, expect.objectContaining({',
  '    deadLetterErrorDescription: expect.stringContaining("Required"),',
  '  }));',
  '  const label = "Required";',
  '});',
]);
write('src/errors.ts', [
  "import { ZodError } from 'zod';",
  "export const isMissing = (e: ZodError) => e.issues[0]?.message === 'Required';",
  "export const wrong = 'Expected string, received number';",
  "const schema = z.string({ message: 'Required' });",
  "const name = z.string().min(1, 'Required');",
]);
write('src/Form.tsx', ['export const hint = "Required";']);
write('node_modules/x/a.test.ts', ['expect(a).toBe("Required");']);

it('finds zod 3 default messages where depending on one is plausible', () => {
  expect(defaultMessageSites(root, ['.'])).toEqual([
    {
      file: 'src/errors.ts',
      line: 2,
      text: 'Required',
      now: 'Invalid input: expected <type>, received undefined',
      replacement: 'received undefined',
    },
    {
      file: 'src/errors.ts',
      line: 3,
      text: 'Expected string, received number',
      now: 'Invalid input: expected <type>, received <type>',
      replacement: 'Invalid input: expected string, received number',
    },
    // In a test, only inside an assertion: the `label` two lines below is not one.
    {
      file: 'src/queue/Adapter.test.ts',
      line: 3,
      text: 'Required',
      now: 'Invalid input: expected <type>, received undefined',
      replacement: 'received undefined',
    },
  ]);
});

it('proposes an edit only for a test the migrated code made fail, and words the decision', () => {
  const context = {
    from: '3.25.76',
    to: '4.6.5',
    includeDeprecated: false,
    ...zodPack.scanContext?.(root, ['.']),
  };
  // The runner names the file relative to its project root; the site is repository-relative.
  const edits = zodPack.testFollowUps?.({
    root,
    workspaces: ['.'],
    failing: ['queue/Adapter.test.ts'],
    context,
  });
  expect(edits).toEqual([
    {
      file: 'src/queue/Adapter.test.ts',
      line: 3,
      before: '    deadLetterErrorDescription: expect.stringContaining("Required"),',
      after: '    deadLetterErrorDescription: expect.stringContaining("received undefined"),',
      reason:
        'zod 4 says "Invalid input: expected <type>, received undefined" where zod 3 said "Required"; the assertion follows',
    },
  ]);
  // Nothing failed there: the code that compares the message is reported, never rewritten.
  expect(
    zodPack.testFollowUps?.({ root, workspaces: ['.'], failing: ['other.test.ts'], context }),
  ).toEqual([]);
  const followed = (edits ?? []).map((e) => ({ rule: 'default-messages', ...e }));
  expect(zodPack.decisions?.(context, [], followed)).toEqual([
    '- Zod 4 words its default error messages differently, and a test of the migrated code failed on it. Updated 1 assertion: `src/queue/Adapter.test.ts:3` `"Required"` → `"received undefined"` (zod 4 says "Invalid input: expected <type>, received undefined"). Confirm that nothing outside the tests reads this text: logs, alerts, dead-letter descriptions, API responses.',
    '- 2 other places depend on a zod default message, which zod 4 words differently, and were not changed: `src/errors.ts:2` `"Required"`; `src/errors.ts:3` `"Expected string, received number"`.',
  ]);
  expect(zodPack.decisions?.({ ...context, defaultMessages: [] }, [], [])).toEqual([]);
});

it('gives an exact matcher the whole zod 4 sentence, from the failure the runner printed', () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-zod-exact-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src/log.test.ts'),
    [
      "import { expect, it } from 'vitest';",
      "it('reports a missing path', () => {",
      "  expect(parse({}).error?.issues[0]?.message).toBe('Required');",
      '});',
    ].join('\n'),
  );
  const context = {
    from: '3.25.76',
    to: '4.6.5',
    includeDeprecated: false,
    ...zodPack.scanContext?.(root, ['.']),
  };
  const run = (output?: string) =>
    zodPack.testFollowUps?.({
      root,
      workspaces: ['.'],
      failing: ['src/log.test.ts'],
      context,
      ...(output !== undefined ? { output } : {}),
    });
  const printed =
    'Expected: "Required"\nReceived: "Invalid input: expected string, received undefined"';
  expect(run(printed)?.map((e) => e.after)).toEqual([
    "  expect(parse({}).error?.issues[0]?.message).toBe('Invalid input: expected string, received undefined');",
  ]);
  const followed = (run(printed) ?? []).map((e) => ({ rule: 'default-messages', ...e }));
  expect(zodPack.decisions?.(context, [], followed)?.[0]).toContain(
    '`src/log.test.ts:3` `"Required"` → `"Invalid input: expected string, received undefined"`. Confirm',
  );
  // Without the sentence, or with two different ones, a substring would fail `toBe`: no edit.
  expect(run()).toEqual([]);
  expect(run(`${printed}\nReceived: "Invalid input: expected number, received undefined"`)).toEqual(
    [],
  );
});
