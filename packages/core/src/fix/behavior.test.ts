import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createNpmFetcher, releasePackage } from '../fetch/npm-fetcher.js';
import { behaviorCheck, schemaSlices } from './behavior.js';
import type { FixSite } from './types.js';

it('slices touched schema dependencies without invoking unrelated route registration', () => {
  const source =
    "import {z} from 'zod';\nconst first=z.string();\nconst second=z.object({name:first});\nstartServer();";
  const slices = schemaSlices(source, [{ line: 2, column: 16 }]);
  expect([...slices.paths.keys()]).toEqual(['first', 'second']);
  expect(slices.paths.get('second')).toEqual([['name']]);
  expect(slices.slice('second')).toContain('first');
  expect(slices.slice('second')).not.toContain('startServer');
});
it.runIf(process.env.UPTIDE_NETWORK === '1')(
  'compares real zod/v3 and zod, ignores default wording, catches custom messages and output drift',
  async () => {
    const fetcher = createNpmFetcher();
    const pkg = await fetcher.fetch('zod', '4.6.5');
    const root = mkdtempSync(join(tmpdir(), 'uptide-behavior-test-'));
    try {
      mkdirSync(join(root, 'node_modules'));
      symlinkSync(pkg.dir, join(root, 'node_modules/zod'));
      const before =
        "import {z} from 'zod';\nexport const schema=z.object({name:z.string({required_error:'Required',invalid_type_error:'Wrong'}).min(2)});";
      const after =
        "import {z} from 'zod';\nexport const schema=z.object({name:z.string({error:(iss)=>iss.input===undefined?'Required':'Wrong'}).min(2)});";
      writeFileSync(join(root, 'schema.ts'), after);
      const sites = [
        {
          finding: { usage: { file: 'schema.ts', line: 2, column: 55 } },
          outcome: 'mechanical',
          reason: '',
        },
      ] as FixSite[];
      const run = () => behaviorCheck(root, new Map([['schema.ts', before]]), sites)[0];
      const a = run();
      expect(a?.skipped).toBeUndefined();
      expect(a?.schemaKind).toBe('single-field');
      expect(a?.inputs).toBe(200);
      expect(a?.identical).toBe(200);
      expect(a?.validInputs).toBeGreaterThanOrEqual(20);
      expect(a?.messageChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ input: 'missing', status: 'identical', before: 'Required' }),
          expect.objectContaining({ input: 'wrong-type', status: 'identical', before: 'Wrong' }),
        ]),
      );
      expect(run()).toEqual(a);
      mkdirSync(join(root, 'schemas'));
      writeFileSync(
        join(root, 'schemas/value.ts'),
        "import {z} from 'zod'; export const name=z.string(); startServer();",
      );
      writeFileSync(
        join(root, 'schemas/instance.ts'),
        "import {z} from 'zod'; import {name} from './value.js'; export const instance=z.object({name}); throw new Error('application code must not run');",
      );
      const cross =
        "import {z} from 'zod'; import {instance} from './schemas/instance.js';\nexport const schema=z.object({name:z.string({required_error:'Required',invalid_type_error:'Wrong'}),instance});";
      writeFileSync(
        join(root, 'schema.ts'),
        cross.replace(
          "required_error:'Required',invalid_type_error:'Wrong'",
          "error:(iss)=>iss.input===undefined?'Required':'Wrong'",
        ),
      );
      const crossResult = behaviorCheck(root, new Map([['schema.ts', cross]]), sites)[0];
      expect(crossResult?.skipped).toBeUndefined();
      expect(crossResult?.schemaKind).toBe('object');
      expect(crossResult?.loadedModules).toEqual([
        'schema.ts',
        'schemas/instance.ts',
        'schemas/value.ts',
      ]);
      expect(crossResult?.validInputs).toBeGreaterThanOrEqual(20);
      expect(crossResult?.identical).toBe(200);
      writeFileSync(
        join(root, 'schemas/value.ts'),
        "function startServer(){throw new Error('executed app')} export const name=startServer();",
      );
      expect(behaviorCheck(root, new Map([['schema.ts', cross]]), sites)[0]?.skipped).toContain(
        'application',
      );
      const nested =
        "import {z} from 'zod';\nexport const schema=z.object({users:z.array(z.object({name:z.string({required_error:'Required',invalid_type_error:'Wrong'})}))});";
      writeFileSync(
        join(root, 'schema.ts'),
        nested.replace(
          "required_error:'Required',invalid_type_error:'Wrong'",
          "error:(iss)=>iss.input===undefined?'Required':'Wrong'",
        ),
      );
      const nestedResult = behaviorCheck(root, new Map([['schema.ts', nested]]), [
        {
          ...sites[0],
          finding: { ...sites[0]?.finding, usage: { file: 'schema.ts', line: 2, column: 95 } },
        },
      ] as FixSite[])[0];
      expect(nestedResult?.messageChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['users', 0, 'name'],
            input: 'missing',
            status: 'identical',
          }),
          expect.objectContaining({
            path: ['users', 0, 'name'],
            input: 'wrong-type',
            status: 'identical',
          }),
        ]),
      );
      const regexBefore =
        "import {z} from 'zod';\nexport const schema=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);";
      writeFileSync(join(root, 'schema.ts'), regexBefore);
      const regexResult = behaviorCheck(root, new Map([['schema.ts', regexBefore]]), [
        {
          ...sites[0],
          finding: {
            ...sites[0]?.finding,
            usage: { ...sites[0]?.finding.usage, file: 'schema.ts', line: 2, column: 25 },
          },
        },
      ] as FixSite[])[0];
      expect(regexResult?.validInputs).toBeGreaterThan(0);
      expect(regexResult?.schemaKind).toBe('single-field');
      for (const [expression, kind] of [
        ['z.enum(["a", "b"])', 'enum'],
        ['z.literal("only").optional()', 'literal'],
        ['z.object({name:z.string()}).refine(x=>!!x.name)', 'single-field'],
        ['z.object({name:z.string(),count:z.number()}).optional()', 'object'],
      ]) {
        const source = `import {z} from 'zod';\nexport const schema=${expression};`;
        writeFileSync(join(root, 'schema.ts'), source);
        const result = behaviorCheck(root, new Map([['schema.ts', source]]), [
          {
            ...sites[0],
            finding: { ...sites[0]?.finding, usage: { file: 'schema.ts', line: 2, column: 25 } },
          },
        ] as FixSite[])[0];
        expect(result?.skipped).toBeUndefined();
        expect(result?.schemaKind).toBe(kind);
      }
      writeFileSync(join(root, 'schema.ts'), after);

      writeFileSync(join(root, 'schema.ts'), after.replace("'Required'", "'Different'"));
      const changed = run();
      expect(changed?.differences.some((d) => d.kind === 'custom-message')).toBe(true);
      expect(changed?.messageChecks).toContainEqual(
        expect.objectContaining({
          input: 'missing',
          status: 'different',
          before: 'Required',
          after: 'Different',
        }),
      );
      writeFileSync(
        join(root, 'schema.ts'),
        after.replace('.min(2)', '.min(2).transform(x=>x.toUpperCase())'),
      );
      expect(run()?.differences.some((d) => d.kind === 'output')).toBe(true);
      writeFileSync(
        join(root, 'schema.ts'),
        "import {unknown} from 'external'; export const schema=unknown();",
      );
      expect(run()?.skipped).toMatch(/unstubbed|application call skipped/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await releasePackage(fetcher, pkg);
    }
  },
  60000,
);
