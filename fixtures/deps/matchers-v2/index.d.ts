/** v2: the assertion owns its matchers (`Matchers<R, T>` of this module); the global `checks.Matchers` is no longer read. */
export interface Matchers<R, T> {
  toBe(expected: T): R;
}
// biome-ignore lint/suspicious/noEmptyInterface: the shape consumers augment
export interface Assertion<T> extends Matchers<void, T> {}
export declare function expect<T>(value: T): Assertion<T>;
