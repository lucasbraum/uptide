import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffPackage } from '../../diff-package.js';
import type { PackageDir } from '../../domain/adapter.js';
import type { PackageFetcher, SurfaceCache } from '../../domain/io.js';
import type { ApiSurface } from '../../domain/surface.js';
import { createTypescriptAdapter } from './index.js';

/** Two versions of a small axios-shaped package, written to temp dirs. */
function writePackage(version: string, dts: string): PackageDir {
  const dir = mkdtempSync(join(tmpdir(), `uptide-compat-${version}-`));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'shape',
      version,
      types: 'index.d.ts',
      exports: { '.': { types: './index.d.ts' }, './sub': { types: './sub/index.d.ts' } },
    }),
  );
  writeFileSync(join(dir, 'index.d.ts'), dts);
  writeFileSync(join(dir, 'sub/index.d.ts'), 'export declare const marker: 1;\n');
  return { name: 'shape', version, dir };
}

const DTS_A = `
export interface AbortSignalLike { aborted: boolean; onabort: () => void; reason: unknown; extra: string }
export interface GenericAbortSignal { aborted: boolean; onabort?: (() => void) | null }
export interface Adapter { (config: Config): Promise<Response> }
export interface Progress { loaded: number; total?: number }
export interface Response { status: string; data: unknown }
export type AxiosPromise<T = any> = Promise<Response>;
export interface Proxy { auth?: { username: string; password: string }; host: string }
export interface Config {
  signal?: AbortSignalLike;
  adapter?: Adapter;
  beforeRedirect?: (options: Record<string, any>, responseDetails: { headers: Record<string, string> }) => void;
  onDownloadProgress?: (progressEvent: any) => void;
  paramsSerializer?: (params: any) => string;
  timeout?: number;
  readonly baseURL?: string;
}
export interface Instance {
  (config: Config): AxiosPromise;
  (url: string, config?: Config): AxiosPromise;
}
export interface Static { all<T>(values: Array<Promise<T> | T>): Promise<T[]>; spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R; isErr(payload: any): payload is Error }
export interface Manager<V> { use<T = V>(onFulfilled?: (value: V) => Promise<T> | T, onRejected?: (error: any) => any): number }
export interface Transformer { (data: any, headers?: Record<string, string>): any }
export declare function create(config?: Config): Instance;
export declare function request(url: string): Promise<Response>;
export declare class Client<T = unknown> { constructor(config: Config); run(input: T): Promise<Response>; static version: string }
export declare namespace Ns { function helper(a: string): void }
`;

const DTS_B = `
export interface AbortSignalLike { aborted: boolean; onabort: () => void; reason: unknown; extra: string }
export interface GenericAbortSignal { aborted: boolean; onabort?: (() => void) | null }
export interface InternalConfig extends Config { headers: Record<string, string> }
export interface Adapter { (config: InternalConfig): Promise<Response> }
export type AdapterConfig = Adapter | 'xhr' | 'http';
export interface Progress { loaded: number; total?: number }
export interface Response { status: number; data: unknown }
export type AxiosPromise<T = any> = Promise<Response>;
type Milliseconds = number;
export interface SerializerOptions { encode?: (v: string) => string; serialize?: CustomSerializer }
export type CustomSerializer = (params: Record<string, any>, options?: SerializerOptions) => string;
export interface Basic { username: string; password: string }
export interface Proxy { auth?: Basic; host: string }
export interface Config {
  signal?: GenericAbortSignal;
  adapter?: AdapterConfig | AdapterConfig[];
  beforeRedirect?: (options: Record<string, any>, responseDetails: { headers: Record<string, string>; statusCode: number }) => void;
  onDownloadProgress?: (progressEvent: Progress) => void;
  paramsSerializer?: CustomSerializer | SerializerOptions;
  timeout?: Milliseconds;
  readonly baseURL?: string | URL;
}
export interface Instance {
  <T = any, R = Response, D = any>(config: Config): Promise<R>;
  <T = any, R = Response, D = any>(url: string, config?: Config): Promise<R>;
}
export interface CreateDefaults extends Config { extraRequired: boolean }
export declare function all<T>(values: (T | Promise<T>)[]): Promise<T[]>;
export declare function spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R;
export declare function isErr<T = any>(payload: any): payload is Error;
export interface Static { all: typeof all; spread: typeof spread; isErr: typeof isErr }
export interface Manager<V> { use(onFulfilled?: ((value: V) => Promise<V> | V) | null, onRejected?: ((error: any) => any) | null): number }
export interface Transformer { (this: Config, data: any, headers: Record<string, string>): any }
export declare function create(config?: CreateDefaults): Instance;
export declare function request(url: string, init?: RequestInit): Promise<Response>;
export declare class Client<T = unknown> { constructor(config: Config); run(input: T): Promise<Response | undefined>; static version: number }
export declare namespace Ns { function helper(a: string | number): void }
`;

const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-27T00:00:00.000Z') });

function memoryCache(): SurfaceCache {
  const store = new Map<string, ApiSurface>();
  return {
    async get(k) {
      return store.get(`${k.version}`);
    },
    async set(k, s) {
      store.set(`${k.version}`, s);
    },
  };
}

/** diffPackage removes the directories it was given, so every fetch writes fresh ones. */
const fetcher: PackageFetcher = {
  resolve: async (_name, requested) => requested,
  async fetch(_name, version) {
    return writePackage(version, version === '1.0.0' ? DTS_A : DTS_B);
  },
};

describe('compat program (assignability)', () => {
  it('classifies the axios shapes the way a consumer experiences them', async () => {
    const changes = await diffPackage({
      name: 'shape',
      from: '1.0.0',
      to: '2.0.0',
      adapter,
      fetcher,
      cache: memoryCache(),
    });
    const by = Object.fromEntries(changes.map((c) => [c.path, c]));

    // AbortSignal-like -> a structural subset: widened property, direction unknown.
    expect(by['Config#signal']).toMatchObject({
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
    });
    expect(by['Config#signal']?.notes).toBe(
      'type widened; breaking if the member is read by the consumer',
    );
    // Adapter -> union including Adapter: widened.
    expect(by['Config#adapter']).toMatchObject({
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
    });
    // Callback whose parameter gained a required field: the implementation receives more. Additive.
    expect(by['Config#beforeRedirect']).toMatchObject({ severity: 'additive', confidence: 0.6 });
    expect(by['Config#beforeRedirect']?.notes).toMatch(
      /callback parameter 'responseDetails' narrowed/,
    );
    // A callback property replaced by a union that still accepts the old function: widened, additive.
    expect(by['Config#paramsSerializer']).toMatchObject({
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
    });
    expect(by['Config#paramsSerializer']?.notes).not.toMatch(/callable/);
    // any -> Progress on a callback parameter: narrowed, additive at 0.6.
    expect(by['Config#onDownloadProgress']).toMatchObject({
      kind: 'narrowed',
      severity: 'additive',
      confidence: 0.6,
    });
    // number -> Milliseconds, a NON-exported alias of number: resolved in the module's own scope, equivalent.
    expect(by['Config#timeout']).toBeUndefined();
    // Inline literal replaced by an equivalent named type: no change, and no "removed" members.
    expect(by['Proxy#auth']).toBeUndefined();
    expect(by['Proxy#auth#username']).toBeUndefined();
    expect(by['Proxy#auth#password']).toBeUndefined();
    // readonly output widened: readers must handle URL now.
    expect(by['Config#baseURL']).toMatchObject({ kind: 'widened', severity: 'breaking' });
    // Generic overloads equivalent to the old ones: no change.
    expect(by['Instance#()']).toBeUndefined();
    // Generic method -> function-typed property with the same signature (AxiosStatic#all): no change.
    expect(by['Static#all']).toBeUndefined();
    expect(by['Static#spread']).toBeUndefined();
    // A required function-valued property is called, not implemented; a type parameter with a
    // default added to it changes nothing for callers.
    expect(by['Static#isErr']).toBeUndefined();
    // AxiosInterceptorManager#use<T> -> use: the types are compatible, but `use<Foo>(...)` stops compiling.
    expect(by['Manager#use']).toMatchObject({
      kind: 'signature',
      severity: 'breaking',
      confidence: 0.6,
    });
    expect(by['Manager#use']?.notes).toBe('explicit type arguments will no longer compile');
    // AxiosRequestTransformer#() is implemented by the consumer: `headers` always provided and a
    // `this` context are free for the implementation. `data` is any on both sides and is not named.
    expect(by['Transformer#()']).toMatchObject({ severity: 'additive' });
    expect(by['Transformer#()']?.notes).toBe(
      "this parameter added (Config); callback parameter 'headers' now always provided",
    );
    // AxiosAdapter#(): a call-signature-only interface the consumer implements; a narrower argument is fine.
    expect(by['Adapter#()']).toMatchObject({ severity: 'additive' });
    expect(by['Adapter#()']?.notes).toMatch(/callback parameter 'config' narrowed/);
    // status string -> number: incompatible.
    expect(by['Response#status']).toMatchObject({ kind: 'type', severity: 'breaking' });
    // Parameter narrowed to a subtype with a required field: callers break.
    expect(by.create).toMatchObject({ kind: 'signature', severity: 'breaking' });
    expect(by.create?.notes).toMatch(/parameter 'config' type narrowed/);
    // Optional parameter added: additive.
    expect(by.request).toMatchObject({ kind: 'signature', severity: 'additive' });
    // Method return widened with undefined: callers must handle it.
    expect(by['Client#run']).toMatchObject({ kind: 'signature', severity: 'breaking' });
    expect(by['Client#run']?.notes).toMatch(/return type widened/);
    // Static property string -> number: incompatible output.
    expect(by['Client.version']).toMatchObject({ kind: 'type', severity: 'breaking' });
    // Namespace function parameter widened: additive at 0.8, no note.
    expect(by['Ns.helper']).toMatchObject({
      kind: 'signature',
      severity: 'additive',
      confidence: 0.8,
    });
    expect(by['Ns.helper']?.notes).toBeUndefined();
  });

  it('can be switched off, leaving the textual verdicts', async () => {
    const changes = await diffPackage({
      name: 'shape',
      from: '1.0.0',
      to: '2.0.0',
      adapter,
      fetcher,
      cache: memoryCache(),
      assignability: false,
    });
    const by = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(by['Config#signal']).toMatchObject({ kind: 'type', severity: 'breaking' });
    expect(by['Instance#()']).toMatchObject({ kind: 'signature', severity: 'breaking' });
  });
});
