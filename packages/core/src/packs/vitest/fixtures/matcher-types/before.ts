import { expect } from 'vitest';

declare global { // @uptide matcher-types at:declare
  namespace jest {
    interface Matchers<R = void, T = {}> {
      toEqualBits(buffer: Uint8Array): R;
    }
  }
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> { // @uptide matcher-types at:interface
    toHaveStyleRule(property: string): void;
  }
}

declare module 'vitest' {
  interface Matchers<R> { // @uptide matcher-types at:interface
    toBeWithin(low: number, high: number): R;
  }
}

// Already the Vitest 5 shape: two type parameters.
declare module 'vitest' {
  interface Matchers<R, T> { // @uptide matcher-types keep
    toEqualBits(buffer: Uint8Array): R;
  }
}

// Not a vitest module: its Assertion is its own.
declare module 'chai' {
  interface Assertion<T = any> {
    toBeFoo(): T;
  }
}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      VITEST_POOL_ID?: string;
    }
  }
}

expect.extend({});
