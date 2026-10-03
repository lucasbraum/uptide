import type { Item } from './item.js';
export * from './shapes.js';
export { Item };
export { createClient, createClient as makeClient } from './client.js';
export * as shapes from './shapes.js';
export { Client } from './client.js';

/** Parses input. */
export declare function parse(input: string): Item;
export declare function parse(input: string, options: ParseOptions): Item;


export interface ParseOptions {
  /** Whether to be strict. */
  strict?: boolean;
  /** v2: widened. */
  mode: 'loose' | 'strict' | 'auto' | 'fast';
  /** Nested anonymous object: members are expanded under this property. */
  hooks?: {
    onStart(): void;
    onEnd?: (result: Item) => void;
    /** The consumer implements this and RECEIVES the options: reading them is a read. */
    onConfigure?: (options: ParseOptions) => void;
    /** The consumer implements this and RETURNS options: building them is a write. */
    configure?: () => ParseOptions;
  };
  /** Anonymous element type: expanded as items[]#... */
  items?: Array<{ id: string; quantity?: number }>;
  /** Named element type: NOT expanded through. */
  named: Item[];
  [extra: string]: unknown;
}

export type Mode = ParseOptions['mode'];
export type Loose = 'z' | 'a' | 'm';
export type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };
export type Pair<T> = { left: T; right: T };

export declare enum Level {
  Low = 0,
  High = 1,
  Custom = 'custom',
}

export declare class Parser<T = Item> {
  /** @deprecated construct with {@link createParser} */
  constructor(options?: ParseOptions);
  static create(options?: ParseOptions): Parser;
  static version: string;
  /** Same name as the static above: a different symbol on the instance side. */
  version: number;
  readonly options: ParseOptions;
  private cache;
  protected warn(message: string): void;
  parse(input: string): T;
  parse(input: Buffer): T;
  get size(): number;
  get name(): string;
  set name(value: string);
  #secret: number;
}

export declare namespace Parser {
  interface Stats {
    parsed: number;
  }
  type Callback = (stats: Stats) => void;
  namespace Internals {
    const flag: boolean;
  }
}

export declare function createParser(options?: ParseOptions): Parser;

export interface Headers {
  'content-type'?: string;
  [name: string]: string | undefined;
}

/** A member-only interface a consumer class can implement. */
export interface Visitor {
  readonly name: string;
  visit(item: Item): void;
}

export interface Callable {
  (input: string): Item;
  new (input: string): Callable;
  readonly length: number;
}

/** @deprecated use {@link Parser.version} */
export declare const VERSION: string;

/** @internal */
export declare function internalHelper(): void;

/** @internal Everything under here inherits the marker. */
export interface InternalState {
  ticks: number;
}
export declare let counter: number;

declare const _default: {
  parse: typeof parse;
};
export default _default;

declare module 'other-pkg' {
  interface Request {
    synthetic?: Item;
  }
}
