// An i18next 23 shape (index.d.mts): aliases over a namespace import whose type parameters
// default to `object`, or to generic instantiations with commas of their own
// (`ActualNS extends Namespace = NsByTOptions<Ns, TOpt>, ActualKey = KeyWithContext<Key, TOpt>`),
// over a template literal type.
import * as backendMod from './source/backend.js';
import type { KeyWithContext, Namespace, NsByOptions } from './source/backend.js';

export type { Module } from './source/backend.js';
export type BackendModule<TOptions = object> = backendMod.Backend<TOptions>;
export type Lookup<
  Ns extends Namespace,
  Key,
  TOpt,
  ActualNS extends Namespace = NsByOptions<Ns, TOpt>,
  ActualKey = KeyWithContext<Key, TOpt>,
> = ActualKey extends `${infer Nsp}:${infer RestKey}` ? [Nsp, RestKey] : [ActualNS, ActualKey];
