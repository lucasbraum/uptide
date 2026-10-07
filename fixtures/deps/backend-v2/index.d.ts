// The i18next 26 shape: `BackendModule`'s type parameter renamed (`TOptions` -> `Options`),
// `Lookup` resolving to something else, every default unchanged.
import * as backendMod from './source/backend.js';
import type { KeyWithContext, Namespace, NsByOptions } from './source/backend.js';

export type { Module } from './source/backend.js';
export type BackendModule<Options = object> = backendMod.Backend<Options>;
export type Lookup<
  Ns extends Namespace,
  Key,
  TOpt,
  ActualNS extends Namespace = NsByOptions<Ns, TOpt>,
  ActualKey = KeyWithContext<Key, TOpt>,
> = ActualKey extends `${infer Nsp}:${infer RestKey}` ? [Nsp, RestKey, ActualNS] : string;
