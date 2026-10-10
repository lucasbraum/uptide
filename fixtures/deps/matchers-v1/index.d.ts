/** v1: an assertion reads custom matchers declared on the global `checks.Matchers`, as a consumer's setup file adds them. */
declare global {
  namespace checks {
    // biome-ignore lint/suspicious/noEmptyInterface: augmented by consumers
    interface Matchers<R> {}
  }
}
export interface Assertion<T> extends checks.Matchers<void> {
  toBe(expected: T): void;
}
export declare function expect<T>(value: T): Assertion<T>;
