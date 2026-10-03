/// <reference path="./ambient-extra.d.ts" />
/** Own-package ambient module: walked as the entry point's exports, not as a foreign scope. */
declare module 'synthetic/ambient' {
  export interface Thing {
    a: number;
  }
  export function make(): Thing;
}
