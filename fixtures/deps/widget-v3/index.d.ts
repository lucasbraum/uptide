/** v3: `core()` no longer knows what it holds, and `thing` lost its type entirely. */
export interface Box<T> {
  a: T;
}
export declare function core(): { a: number };
export declare function boxed(): Box<unknown>;
export declare const thing: any;
