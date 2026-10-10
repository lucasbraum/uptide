/** A matcher package that declares its matcher on the global `checks.Matchers`, as jest-image-snapshot does on `jest.Matchers`. */
declare global {
  namespace checks {
    interface Matchers<R> {
      toBeOdd(): R;
    }
  }
}
export declare const toBeOdd: unknown;
