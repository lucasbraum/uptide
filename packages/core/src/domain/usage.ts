/** How a consumer's code touches a dependency symbol. */
export type UsageAccess =
  | 'call'
  | 'construct'
  | 'read'
  | 'write'
  | 'implement'
  | 'typeRef'
  | 'import';

/** How the usage was connected to the symbol. Drives usage certainty in `Finding.confidence`. */
/** `require`: bound by name from a `require()`/`import()` the checker could not type; the surface's names did the matching. */
export type UsageVia = 'direct' | 'alias' | 'reexport' | 'destructure' | 'inferred' | 'require';

/** One place in a consumer repository that touches a dependency symbol. Emitted by the language adapter for EVERY usage, affected or not. */
export interface Usage {
  /** Relative to the repo root. */
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Path in the dependency's ApiSurface under the name the consumer wrote (`makeClient`). */
  symbolPath: string;
  /**
   * The canonical target when `symbolPath` is an alias of it (`createClient`). A change
   * on either path affects this usage: removing the alias, or changing the target.
   */
  canonicalPath?: string;
  access: UsageAccess;
  /** The source line, trimmed. */
  snippet: string;
  via: UsageVia;
  /** The package this usage belongs to, when several are analyzed together (a release group). */
  package?: string;
  /** How the value reached this site: through `require()`/`import x = require()`/`import()`, or an ESM import. */
  loader?: 'require' | 'import';
  /**
   * `false` when the repository does not type-check this file: JavaScript without `checkJs`
   * or a `// @ts-check` pragma, or any file under `@ts-nocheck`. The compiler is not the
   * arbiter there; a finding is breaking only when the runtime probe confirms it
   * (`check/file-kind.ts`).
   */
  checked?: false;
  /** Signal B: the compiler's error at this usage against the target version, when there is one. */
  compileError?: string;
  /** The TypeScript diagnostic code behind `compileError`. */
  compileCode?: number;
}

/** Usage certainty by `via`, multiplied into `Finding.confidence`. */
export const USAGE_CERTAINTY: Record<UsageVia, number> = {
  direct: 1,
  alias: 0.95,
  reexport: 0.95,
  destructure: 0.9,
  inferred: 0.8,
  require: 0.85,
};

/** Every path a usage answers to. Step 4's join uses this, not `symbolPath` alone. */
export function usagePaths(usage: Usage): string[] {
  return usage.canonicalPath !== undefined && usage.canonicalPath !== usage.symbolPath
    ? [usage.symbolPath, usage.canonicalPath]
    : [usage.symbolPath];
}

/** A place the analyzer could not follow: reported, never silently skipped. */
/**
 * A place the analyzer could not follow: a `require`/`import()` whose specifier is not a
 * literal, or whose result flows somewhere untracked (an argument, a property, a return).
 * Bound results (`const x = require('pkg')`, destructuring, `require('pkg').member`) are
 * followed and are not listed here.
 */
export interface Unanalyzed {
  file: string;
  line: number;
  kind: 'require' | 'import-equals' | 'dynamic-import';
}

/** Whether the repository type-checks a file, from its name, its first lines and the program's `checkJs`. */
export function repoTypeChecks(file: string, head: string, checkJs: boolean): boolean {
  if (/@ts-nocheck/.test(head)) return false;
  if (!/\.(js|jsx|cjs|mjs)$/i.test(file)) return true;
  return checkJs || /@ts-check/.test(head);
}

export interface FindUsagesResult {
  usages: Usage[];
  unanalyzed: Unanalyzed[];
  /** The program's `checkJs`: whether its JavaScript files are type-checked. */
  checksJs: boolean;
  /** Source files scanned, for the "call sites checked" denominator and for timing context. */
  filesScanned: number;
  /** Whether `.js`/`.jsx` files were part of the scan (the repo's `allowJs`). */
  includesJs: boolean;
}

/** One error the compiler reports in a repo file against the target version and not against the installed one. */
export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  code: number;
  message: string;
  /** The source line, trimmed, so an inferred usage reads like any other. */
  snippet: string;
  /** The repo declaration this error descends from, when one could be traced (see adapters/typescript/cause.ts). */
  cause?: DiagnosticCause;
}

export interface DiagnosticCause {
  /** Declared name (`parseBody`). */
  name: string;
  file: string;
  line: number;
  /** Why it is to blame, as a clause: "whose type changed from `A` to `B`", "which itself fails to compile against the target", "imported from `x`, which is typed `any` against the target". */
  reason: string;
  /**
   * A compiler option, not a declaration (`"jsx": "preserve"` in a tsconfig): the one edit that
   * resolves the cluster is there, and the diagnostics under it are evidence, not sites to fix.
   */
  config?: true;
  /**
   * The one edit is at the cause itself (a compiler option, a parameter's type), so the
   * cluster is one site and its diagnostics are evidence; without it, the diagnostics are
   * the sites and the cause is where to look first.
   */
  anchorOnly?: true;
}

/** The files Signal B was asked to judge and what became of them: the denominator of a verdict. */
export interface CompileCoverage {
  /** Files type-checked against the target. */
  compiled: number;
  /** Files that use the package (and the files importing them) the signal was asked about. */
  total: number;
  /** Why the rest were not compiled, one entry per reason. */
  skipped: { reason: string; count: number }[];
  /** Which TypeScript judged: the repository's own install, or the bundled fallback. Absent in reports stored before it was kept. */
  compilers?: { version: string; own: boolean }[];
}

/** Signal B: the repo type-checked against the target version. */
export interface CompileSignal {
  diagnostics: CompileDiagnostic[];
  /** Pre-existing errors at the installed version. They are subtracted from the overlay's, not a reason to skip it. */
  baselineErrors: number;
  /** Why the overlay was not compiled: only a structurally broken baseline (invalid tsconfig, most files unresolvable). */
  skipped?: string;
  /** How many of the files asked about were type-checked, and why the others were not. */
  coverage: CompileCoverage;
  /** Bare imports inside the target package's own files that resolved neither there nor in the consumer's node_modules. */
  unresolvedInTarget: string[];
  /** Target declaration files (relative to the target) with an unresolved import; the compiler cannot vouch for symbols declared there. */
  unresolvedFiles: string[];
  /** The target's own dependencies served by the overlay, `name@version (fetched|consumer)`. */
  linkedDependencies: string[];
  /** Package name → directory the overlay served it from, for whoever else must load the target (the runtime probe). */
  linkedDependencyDirs?: Record<string, string>;
  /** Declared ranges of the target that neither the consumer nor the registry could satisfy. */
  unsatisfiedDependencies: string[];
  /** Wall-clock of the baseline and overlay checks, and of resolving the target's dependencies. */
  timing: { baselineMs: number; overlayMs: number; dependenciesMs: number };
}
