import { describe, expect, it } from 'vitest';
import { classify, type UnclassifiedChange } from './classify.js';

const base = {
  package: 'p',
  from: '1.0.0',
  to: '2.0.0',
  path: 'x',
  source: 'types' as const,
  confidence: 1,
};
const one = (c: Partial<UnclassifiedChange>) =>
  classify([{ ...base, kind: 'type', ...c }])[0] as ReturnType<typeof classify>[number];

describe('classify: kinds with fixed severity', () => {
  it('maps removed/required to breaking, added to additive, deprecated to deprecated', () => {
    expect(one({ kind: 'removed' }).severity).toBe('breaking');
    expect(one({ kind: 'required' }).severity).toBe('breaking');
    expect(one({ kind: 'added' }).severity).toBe('additive');
    expect(one({ kind: 'deprecated' }).severity).toBe('deprecated');
  });
});

describe('classify: property and alias types', () => {
  it('union widened is additive at 0.6 with the read caveat, narrowed is breaking', () => {
    const widened = one({ path: 'Response#status', before: 'number', after: 'number | string' });
    expect(widened.severity).toBe('additive');
    expect(widened.confidence).toBe(0.6);
    expect(widened.notes).toBe('type widened; breaking if the member is read by the consumer');
    const narrowed = one({ before: "'a' | 'b' | 'c'", after: "'a' | 'b'" });
    expect(narrowed.severity).toBe('breaking');
  });

  it('unrelated type change is breaking; loosening to any is additive', () => {
    expect(one({ before: 'string', after: 'number' })).toMatchObject({
      severity: 'breaking',
      confidence: 0.7,
    });
    expect(one({ before: 'string', after: 'any' }).severity).toBe('additive');
  });

  it('required -> optional is additive', () => {
    expect(
      one({ before: 'string', after: 'string (optional)', notes: 'member became optional' })
        .severity,
    ).toBe('additive');
  });
});

describe('classify: declaration kind changes', () => {
  const kind = (before: string, after: string) =>
    one({
      kind: 'signature',
      before,
      after,
      notes: `declaration kind changed from ${before.split(':')[0]} to ${after.split(':')[0]}`,
    });

  it('interface <-> type alias is additive at reduced confidence', () => {
    const r = kind(
      'interface: interface<T = any> extends Promise<T>',
      'type: type<T = any> = Promise<T>',
    );
    expect(r.severity).toBe('additive');
    expect(r.confidence).toBe(0.7);
  });

  it('variable -> function compares the calls when both texts are callable', () => {
    const r = kind(
      'variable: const { <V>(value: V): R<V>; <K, V>(key: K, value: V): R<K, V> }',
      'function: <K, V>(key: K, value: V): R<K, V>',
    );
    expect(r.severity).toBe('breaking');
    expect(r.notes).toMatch(/overload removed or changed/);
  });

  it('a method returning `this` instead of its class is not a return change', () => {
    const r = one({
      path: 'ZodString#email',
      kind: 'signature',
      before: '(message?: string): ZodString',
      after: '(params?: string): ZodString',
    });
    expect(r.severity).toBe('additive');
    const self = one({
      path: 'ZodString#email',
      kind: 'signature',
      before: '(message?: string): ZodString',
      after: '(message?: string): this',
    });
    expect(self.severity).toBe('additive');
  });

  it('method -> property and object variable -> namespace keep call sites working', () => {
    expect(kind('method: <T>(v: T[]): Promise<T[]>', 'property: typeof all').severity).toBe(
      'additive',
    );
    expect(kind('variable: const {…}', 'namespace: namespace').severity).toBe('additive');
  });

  it('class -> variable is breaking with a caveat; variable -> type is plainly breaking', () => {
    const r = kind('class: class extends Base', 'variable: const $constructor<X>');
    expect(r.severity).toBe('breaking');
    expect(r.confidence).toBe(0.6);
    expect(kind('variable: const unique symbol', 'type: type<T>').severity).toBe('breaking');
    expect(kind('variable: const unique symbol', 'type: type<T>').confidence).toBe(1);
  });
});

describe('classify: container headers', () => {
  const header = (before: string, after: string) => one({ kind: 'signature', before, after });

  it('a grown extends list is additive; a changed one is breaking', () => {
    expect(header('interface', 'interface extends PaginationParams').severity).toBe('additive');
    expect(header('interface extends A', 'interface extends A, B').severity).toBe('additive');
    expect(header('interface extends A', 'interface extends B').severity).toBe('breaking');
    expect(header('class extends A', 'class').severity).toBe('breaking');
  });

  it('abstract added is breaking, removed is additive; type params changed is breaking', () => {
    expect(header('class', 'abstract class').severity).toBe('breaking');
    expect(header('abstract class', 'class').severity).toBe('additive');
    expect(header('class<T>', 'class<T, U>').severity).toBe('breaking');
  });
});

describe('classify: callables', () => {
  const sig = (before: string, after: string) => one({ kind: 'signature', before, after });

  it('optional param added is additive; required param added is breaking', () => {
    expect(sig('(a: string): void', '(a: string, b?: number): void').severity).toBe('additive');
    expect(sig('(a: string): void', '(a: string, ...rest: number[]): void').severity).toBe(
      'additive',
    );
    expect(sig('(a: string): void', '(a: string, b: number): void').severity).toBe('breaking');
  });

  it('param optionality: required -> optional additive, optional -> required breaking', () => {
    expect(sig('(a: string): void', '(a?: string): void').severity).toBe('additive');
    expect(sig('(a?: string): void', '(a: string): void').severity).toBe('breaking');
  });

  it('param removed is breaking', () => {
    expect(sig('(a: string, b: number): void', '(a: string): void').severity).toBe('breaking');
  });

  it('param type widened is additive at 0.8 with no note, narrowed is breaking (contravariance)', () => {
    const widened = sig('(a: string): void', '(a: string | number): void');
    expect(widened.severity).toBe('additive');
    expect(widened.confidence).toBe(0.8);
    expect(widened.notes).toBeUndefined();
    expect(sig('(a: string | number): void', '(a: string): void').severity).toBe('breaking');
  });

  it('return type narrowed is additive, widened or changed is breaking (outputs invert inputs)', () => {
    expect(sig('(): string | undefined', '(): string').severity).toBe('additive');
    expect(sig('(): string', '(): string | undefined').severity).toBe('breaking');
    expect(sig('(): string', '(): number')).toMatchObject({
      severity: 'breaking',
      confidence: 0.7,
    });
  });

  it('overload added is additive, overload removed is breaking', () => {
    expect(sig('(a: string): T', '(a: string): T; (a: Buffer): T').severity).toBe('additive');
    expect(sig('(a: string): T; (a: Buffer): T', '(a: string): T').severity).toBe('breaking');
  });

  it('type parameter with a default added is additive; other type param changes are breaking', () => {
    expect(sig('(a: string): T', '<D = any>(a: string): T').severity).toBe('additive');
    expect(sig('(a: string): T', '<D>(a: string): T').severity).toBe('breaking');
    expect(sig('<T extends A>(a: T): T', '<T extends B>(a: T): T')).toMatchObject({
      severity: 'breaking',
      confidence: 0.5,
    });
  });

  it('losing a type parameter is breaking at 0.6: explicit type arguments stop compiling', () => {
    const r = sig(
      '<T = V>(onFulfilled?: (value: V) => T): number',
      '(onFulfilled?: (value: V) => V): number',
    );
    expect(r).toMatchObject({
      severity: 'breaking',
      confidence: 0.6,
      notes: 'explicit type arguments will no longer compile',
    });
  });

  it('inline object parameter replaced by a named type is breaking at low confidence', () => {
    const r = sig('(opts: { a: string; b?: number }): string', '(opts: Options): string');
    expect(r.severity).toBe('breaking');
    expect(r.confidence).toBe(0.5);
    expect(r.notes).toMatch(/may be equivalent/);
  });

  it('falls back to breaking when a signature does not parse', () => {
    const r = sig('(a: string): void', '(?: void');
    expect(r.severity).toBe('breaking');
    expect(r.notes).toMatch(/not parsed/);
  });
});
