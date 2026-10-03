export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'enumMember'
  | 'property'
  | 'variable'
  | 'namespace'
  | 'module';

export interface ApiSymbol {
  /** Canonical path; stable across versions when nothing about the symbol changed. See docs/architecture.md. */
  path: string;
  kind: SymbolKind;
  /** Normalized textual form used for comparison. Members of containers are NOT included here. */
  signature: string;
  optional?: boolean;
  /** JSDoc @deprecated text when present, `true` when the tag has no text. */
  deprecated?: string | true;
  /** Entry points that reach this symbol: "." or "./subpath". */
  exportedFrom: string[];
  /**
   * Absent for ordinary public API. `protected` members only matter to subclasses;
   * `internal` marks a JSDoc `@internal` tag on the symbol or an ancestor.
   */
  visibility?: Visibility;
  /**
   * Set when another path reaches the same declaration (`export { a as b }`,
   * `export * as ns`, a type re-exported under several namespaces). Points at the shortest
   * such path. Every alias is a real import name, so aliases stay separate symbols; this
   * lets consumers fold duplicates when counting.
   */
  aliasOf?: string;
  /** Declaration file, relative to the package directory (the first declaration when merged). */
  file?: string;
  /** The module's `export =` root: to a consumer it is the default import, and its namespace members are the named exports. */
  exportEquals?: true;
}

export type Visibility = 'protected' | 'internal';

export interface ApiSurface {
  package: string;
  version: string;
  /** ISO date. */
  extractedAt: string;
  /** Language adapter id, e.g. "typescript". */
  adapter: string;
  /** Flat list, sorted by path. */
  symbols: ApiSymbol[];
}

/**
 * Bumped whenever extraction or path rules change in a way that makes previously cached
 * surfaces incomparable. Cache keys include it so stale surfaces are never reused.
 */
export const SURFACE_SCHEMA_VERSION = 10;
