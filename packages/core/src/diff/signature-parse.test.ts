import { describe, expect, it } from 'vitest';
import { callableShape, parseCallable, splitTopLevel, unionMembers } from './signature-parse.js';

describe('splitTopLevel', () => {
  it('ignores separators inside brackets and strings', () => {
    expect(
      splitTopLevel("a: Map<string, number>, b?: 'x,y', c: (q: number, r: string) => void", ','),
    ).toEqual(['a: Map<string, number>', "b?: 'x,y'", 'c: (q: number, r: string) => void']);
  });
});

describe('unionMembers', () => {
  it('splits only top-level unions', () => {
    expect(unionMembers("'a' | Array<'b' | 'c'> | { x: 1 | 2 }")).toEqual([
      "'a'",
      "Array<'b' | 'c'>",
      '{ x: 1 | 2 }',
    ]);
  });
});

describe('parseCallable', () => {
  it('parses type params, optional, rest and return', () => {
    expect(
      parseCallable('<T = any>(url: string, config?: Config<T>, ...rest: unknown[]): Promise<T>'),
    ).toEqual([
      {
        typeParams: ['T = any'],
        params: [
          { name: 'url', optional: false, rest: false, type: 'string' },
          { name: 'config', optional: true, rest: false, type: 'Config<T>' },
          { name: 'rest', optional: false, rest: true, type: 'unknown[]' },
        ],
        returnType: 'Promise<T>',
      },
    ]);
  });

  it('parses overloads and modifiers, defaults the return type', () => {
    const parsed = parseCallable('protected (a: string); (a: Buffer): number');
    expect(parsed?.map((o) => o.returnType)).toEqual(['void', 'number']);
  });

  it('keeps the this parameter apart from positional parameters', () => {
    const o = parseCallable('(this: Ctx, data: any, headers: H): any')?.[0];
    expect(o?.thisType).toBe('Ctx');
    expect(o?.params.map((p) => p.name)).toEqual(['data', 'headers']);
  });

  it('reads arrow-form returns', () => {
    expect(parseCallable('(params?: RawCreateParams) => ZodAny')?.[0]?.returnType).toBe('ZodAny');
  });

  it('parses destructured parameters and returns undefined on garbage', () => {
    expect(parseCallable('({ a, b }: Opts): void')?.[0]?.params[0]?.type).toBe('Opts');
    expect(parseCallable('not a signature')).toBeUndefined();
  });
});

describe('callableShape', () => {
  it('ignores parameter names and arrow versus colon spelling', () => {
    expect(callableShape('const (params?: P) => Z')).toBe(callableShape('(opts?: P): Z'));
    expect(callableShape('{ (a: string): void; (b: number): void }')).toBe(
      '(string): void; (number): void',
    );
    expect(callableShape('const string')).toBeUndefined();
  });
});

describe('callable detection edge cases', () => {
  it('does not mistake a parenthesized union for a callable', () => {
    expect(parseCallable('(A & B) | C')).toBeUndefined();
    expect(
      callableShape('(RawAxiosRequestHeaders & MethodsHeaders) | AxiosHeaders'),
    ).toBeUndefined();
  });

  it('callableShape ignores type parameter names', () => {
    expect(callableShape('<A, B>(a: A, b: B) => Pipe<A, B>')).toBe(
      callableShape('<ASchema, BSchema>(a: ASchema, b: BSchema): Pipe<ASchema, BSchema>'),
    );
  });
});
