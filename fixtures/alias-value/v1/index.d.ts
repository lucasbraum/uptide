/** The aliases change value in v2; the interface naming them does not change its text. */
export type Version = '2026-07-29';
export type Mode = 'fast' | 'safe';
export interface Config {
  apiVersion?: Version;
  mode?: Mode;
}
/** The stripe shape: a namespace re-declares the alias through an import type. */
export type LatestApiVersion = import('./lib.js').LatestApiVersion;
