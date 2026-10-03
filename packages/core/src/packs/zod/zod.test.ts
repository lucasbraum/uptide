import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../domain/report.js';
import { packFixability } from '../fixability.js';
import { zodPack } from './index.js';

const context = { from: '3.25.76', to: '4.6.5', includeDeprecated: true };
function at(text: string, token: string, deprecated = false): Finding {
  const prefix = text.slice(0, text.indexOf(token));
  return {
    change: {
      package: 'zod',
      from: context.from,
      to: context.to,
      path: deprecated ? 'ZodString#email' : 'string',
      kind: deprecated ? 'deprecated' : 'signature',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
    },
    usage: {
      file: 'a.ts',
      line: prefix.split('\n').length,
      column: (prefix.split('\n').at(-1)?.length ?? 0) + 1,
      endLine: 1,
      endColumn: 1,
      symbolPath: 'string',
      access: 'call',
      snippet: '',
      via: 'direct',
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'mechanical',
    reason: '',
  };
}
const run = (text: string, token: string, deprecated = false) =>
  zodPack.transform(text, at(text, token, deprecated), context);
describe('zod mechanical pack', () => {
  it.each([
    ["required_error: 'A'", "iss.input === undefined ? 'A' : undefined"],
    ["invalid_type_error: 'B'", "iss.input === undefined ? undefined : 'B'"],
    ["required_error: 'A', invalid_type_error: 'B'", "iss.input === undefined ? 'A' : 'B'"],
  ])('migrates %s while preserving comments and other keys', (options, expected) => {
    const text = `import { z } from 'zod';\n// keep\nconst s = z.string({ /* message */ ${options}, description: 'd' }); // tail\n`;
    const result = run(text, 'z.string');
    expect(result.applied).toBe(true);
    expect(result.text).toContain(expected);
    expect(result.text).toContain('/* message */');
    expect(result.text).toContain("description: 'd'");
    expect(result.text).toContain('// tail\n');
    expect(result.text).not.toContain('required_error:');
    expect(result.text).not.toContain('invalid_type_error:');
  });
  it('captures nonliteral expressions eagerly, once, and in their original order', () => {
    const text = `import { z } from 'zod';\nlet count = 0; const next = () => String(++count);\nconst s = z.string({ invalid_type_error: next(), description: next(), required_error: next() });`;
    const result = run(text, 'z.string');
    const js = ts.transpile(result.text.replace("import { z } from 'zod';", ''), {
      target: ts.ScriptTarget.ES2022,
    });
    const output = new Function(
      'z',
      js +
        '; return { count, a:s.error({input:undefined}), b:s.error({input:12}), c:s.error({input:undefined}) };',
    )({ string: (x: unknown) => x });
    expect(output).toEqual({ count: 3, a: '3', b: '1', c: '3' });
  });
  it('only edits the reported call, even with two calls on one line', () => {
    const text =
      "import { z } from 'zod'; const a=z.string({ required_error:'A' }); const b=z.number({ required_error:'B' });";
    const result = run(text, 'z.number');
    expect(result.text).toContain("z.string({ required_error:'A' })");
    expect(result.text).toContain('z.number({ error:');
  });
  it.each(['email', 'uuid', 'url', 'base64', 'datetime'])(
    'moves %s and preserves the following chain/options',
    (method) => {
      const text = `import { z as schema } from 'zod';\nconst s = schema.string().${method}({ message: 'bad' }).optional(); // stay`;
      const result = run(text, method, true);
      expect(result.text).toContain(
        `schema.${method === 'datetime' ? 'iso.datetime' : method}({ error: 'bad' }).optional(); // stay`,
      );
    },
  );
  it('handles enum params and named factory aliases', () => {
    const text =
      "import { enum as choice } from 'zod'; const s = choice(['a'], {required_error:'R'});";
    expect(run(text, "choice(['a']").text).toContain('error: (iss)');
  });
  it('skips other roots, refinements before the format, conflicting options and shadowed z', () => {
    for (const expression of [
      'external.email()',
      'z.string().trim().email()',
      'z.string({message:"x"}).email()',
    ]) {
      const text = `import { z } from 'zod'; const s = ${expression};`;
      expect(run(text, 'email', true).applied).toBe(false);
    }
    const text =
      "import { z } from 'zod'; function f(z:any) { return z.string({required_error:'x'}); }";
    expect(run(text, 'z.string').applied).toBe(false);
    for (const extra of ['...options', 'error: custom', 'errorMap: custom']) {
      const t = `import { z } from 'zod'; z.string({required_error:'x', ${extra}});`;
      expect(run(t, 'z.string').applied).toBe(false);
    }
  });
  it('does not migrate deprecated sites without the flag or unrelated versions', () => {
    const text = "import { z } from 'zod'; z.string().email();";
    expect(
      zodPack.transform(text, at(text, 'email', true), { ...context, includeDeprecated: false })
        .applied,
    ).toBe(false);
    expect(zodPack.supports('4.1.0', '4.6.5')).toBe(false);
  });
});

it('retains comments inside replaced options, including line comments', () => {
  const text =
    "import { z } from 'zod';\nz.string({ required_error: /* required */ 'A', invalid_type_error: // invalid\n 'B' });";
  const result = run(text, 'z.string');
  expect(result.text).toContain('/* required */');
  expect(result.text).toContain('// invalid\n');
  const js = ts.transpile(result.text.replace("import { z } from 'zod';", ''));
  expect(() => new Function('z', js)({ string: (x: unknown) => x })).not.toThrow();
});

it('check promises a mechanical fix only when the actual rule passes its safety guards', () => {
  for (const [options, mechanical] of [
    ["required_error: 'Required'", true],
    ["required_error: 'Required', errorMap: custom", false],
  ] as const) {
    const source = `import {z} from 'zod'; const schema = z.string({${options}});`;
    const finding = { ...at(source, 'required_error'), fixability: 'assisted' as const };
    expect(packFixability(finding, source, zodPack).fixability).toBe(
      mechanical ? 'mechanical' : 'assisted',
    );
  }
});
