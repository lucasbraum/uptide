export type Version = '2026-08-26';
export type Mode = 'fast';
export interface Config {
  apiVersion?: Version;
  mode?: Mode;
}
export type LatestApiVersion = import('./lib.js').LatestApiVersion;
