/**
 * Signal C: what a package's copy does when loaded, observed in a sandboxed child process.
 * Types can say `export =` became a default export while `module.exports` is unchanged; only
 * loading tells. Recorded per copy and diffed installed against target.
 */
export interface RuntimeLoad {
  ok: boolean;
  code?: string;
  message?: string;
  missing?: string;
  /** The file that asked for `missing`, when Node said. */
  from?: string;
  /** The range that file's package declares for `missing` (`*` when it declares none). */
  missingRange?: string;
  kind?: string;
  keys?: Record<string, string>;
  callable?: boolean;
  constructable?: boolean;
  defaultKind?: string;
  defaultCallable?: boolean;
  defaultConstructable?: boolean;
  defaultKeys?: string[];
}

export interface RuntimeSurface {
  package: string;
  version: string;
  /** The Node that did the loading (`v22.20.0`). */
  node: string;
  /** Whether that Node is the repository's resolved version, or the one running uptide. */
  nodeSource: 'repository' | 'current';
  require: RuntimeLoad;
  import: RuntimeLoad;
  /** Nothing can be concluded: a native addon, a dependency the sandbox could not provide. */
  inconclusive?: string;
}

export type RuntimeChangeKind =
  | 'require-throws'
  | 'import-throws'
  | 'key-removed'
  | 'callable-lost'
  | 'constructable-lost'
  | 'namespace-instead';

export interface RuntimeChange {
  kind: RuntimeChangeKind;
  /** The export key, for `key-removed`. */
  key?: string;
  /** `require` or `import`: which loader observed it. */
  loader: 'require' | 'import';
  detail: string;
}

export interface RuntimeDiff {
  changes: RuntimeChange[];
  /** Set when either side was inconclusive; the changes list is then empty. */
  inconclusive?: string;
}

/** A probe skipped for binaries/lifecycle hooks cannot confirm runtime compatibility. */
export function isNativeProbeSkip(reason: string | undefined): boolean {
  return (
    reason !== undefined &&
    /native addon|install script|platform-specific optional dependencies|native package/.test(
      reason,
    )
  );
}
