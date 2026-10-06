import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadedRepo } from './adapters/typescript/repo.js';
import { resetSharedState } from './shared-state.js';

const CONSUMER = resolve(import.meta.dirname, '../../../fixtures/repos/synthetic-consumer');

it('discards the consumer program on reset: the next package gets a fresh program and checker', () => {
  const before = loadedRepo(CONSUMER);
  // Cached between packages while nothing failed.
  expect(loadedRepo(CONSUMER)).toBe(before);
  resetSharedState();
  const after = loadedRepo(CONSUMER);
  expect(after).not.toBe(before);
  expect(after.project.getProgram()).not.toBe(before.project.getProgram());
  expect(after.project.getSourceFiles().map((f) => f.getFilePath())).toEqual(
    before.project.getSourceFiles().map((f) => f.getFilePath()),
  );
});

/**
 * Module-level holders of TypeScript state, and the files that register a reset. A new Map,
 * WeakMap, ts-morph Project or printer at module level outlives one package: its file must
 * register with shared-state, or the line say it holds nothing TypeScript-dependent.
 */
const HOLDER =
  /^(?:export )?(?:const|let|var) [\w$]+.*(?:\bnew (?:Map|WeakMap|Project)\b|\bcreatePrinter\()/;
const MARK = '// shared-state: not TS-dependent';
function unregistered(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => {
    if (text.includes('onReset(')) return [];
    const lines = text.split('\n');
    return lines.flatMap((line, i) =>
      HOLDER.test(line) && !line.includes(MARK) && !lines[i - 1]?.includes(MARK)
        ? [`${path}:${i + 1}: ${line.trim()}`]
        : [],
    );
  });
}

it('finds no module-level TypeScript state that a failed package could leave behind', () => {
  const root = resolve(import.meta.dirname);
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ path: f, text: readFileSync(join(root, f), 'utf8') }));
  expect(files.length).toBeGreaterThan(50);
  expect(unregistered(files)).toEqual([]);
});

it('flags an unregistered cache, and accepts a registered or marked one', () => {
  const cache = 'const programs = new Map<string, ts.Program>();';
  expect(unregistered([{ path: 'a.ts', text: cache }])).toEqual([`a.ts:1: ${cache}`]);
  expect(unregistered([{ path: 'b.ts', text: 'export let p = ts.createPrinter();' }])).toHaveLength(
    1,
  );
  expect(unregistered([{ path: 'c.ts', text: 'const project = new Project({});' }])).toHaveLength(
    1,
  );
  // Inside a function, a holder lives for one call only.
  expect(
    unregistered([{ path: 'd.ts', text: `function f() {\n  const m = new Map();\n}` }]),
  ).toEqual([]);
  expect(
    unregistered([{ path: 'e.ts', text: `${cache}\nonReset(() => programs.clear());` }]),
  ).toEqual([]);
  expect(
    unregistered([{ path: 'f.ts', text: `${MARK}\nconst seen = new Map<string, string>();` }]),
  ).toEqual([]);
});
