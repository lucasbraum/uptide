import type { Visibility } from './surface.js';

/** `info` is only ever a Finding severity: a demoted verdict the compiler did not object to. It counts nowhere. */
/**
 * `info` and `unverified` are only ever Finding severities. `info`: a verdict the compiler
 * did not object to, counted nowhere. `unverified`: the compiler could not judge because the
 * symbol's declaration file has unresolved imports in the target; shown, not counted as breaking.
 */
export type Severity = 'breaking' | 'deprecated' | 'additive' | 'info' | 'unverified';

export type ChangeKind =
  | 'removed'
  | 'renamed'
  | 'moved'
  | 'signature'
  | 'type'
  | 'widened'
  | 'narrowed'
  | 'required'
  | 'added'
  | 'deprecated'
  /** Only on a Finding: a root-cause anchor, the repo declaration downstream errors trace to. Not a call site. */
  | 'cause'
  /** The package stopped supporting `require()` (ESM-only). Path `.`; joins every require() site. */
  | 'module-format';

export interface Change {
  package: string;
  /** Version A. */
  from: string;
  /** Version B. */
  to: string;
  /** Canonical symbol path, e.g. `Stripe.SubscriptionCreateParams#items[]#quantity`. */
  path: string;
  kind: ChangeKind;
  severity: Severity;
  /** Serialized signature/type in A. */
  before?: string;
  /** Serialized signature/type in B. */
  after?: string;
  /** Canonical path of the likely replacement (renames), or the new entry point (moved). */
  replacement?: string;
  /** Exact version where the change first appears. Optional in milestone 1. */
  introducedIn?: string;
  /** `pack`: a migration pack saw it in the code, no type diff did (`check/plan`). */
  source: 'types' | 'jsdoc' | 'pack';
  /** 0..1 */
  confidence: number;
  notes?: string;
  /** Copied from the symbol: `protected` or `internal` symbols are not most consumers' concern. */
  visibility?: Visibility;
  /** Copied from the symbol: this path is another name for `aliasOf`, which has the same change. */
  aliasOf?: string;
  /** How a signature/type verdict was reached: the type checker, or text comparison as a fallback. */
  evidence?: 'checker' | 'text';
  /** `module-format` only: whether the repository's Node can require() an ES module. */
  requireEsm?: 'yes' | 'no' | 'unknown';
  /** `module-format` only: the path a bare `require()` value stands for (the `export =` root, or `default`). */
  loadRoot?: string;
  /** `module-format` only: the target's ESM graph awaits at top level, so require(esm) fails whatever the shape. */
  topLevelAwait?: boolean;
}
