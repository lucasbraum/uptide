import type { ErrorCode } from '../errors.js';
import type { Change, Severity } from './change.js';
import type { RuntimeChange, RuntimeLoad } from './runtime.js';
import type { CompileCoverage, CompileDiagnostic, Unanalyzed, Usage } from './usage.js';

/** `none`: an additive finding, nothing to change; it counts in callSitesChecked only. */
export type Fixability = 'mechanical' | 'assisted' | 'manual' | 'unknown' | 'none';

/** A compile error downstream of a root-cause anchor; `file` is repository-relative. */
export interface DownstreamSite {
  column?: number;
  snippet?: string;
  file: string;
  line: number;
  code: number;
  message: string;
  /** The workspace the site is in, when the anchor gathers sites from several. */
  workspace?: string;
}

/** `verified`: a migration pack covers the upgrade. `generic`: analysis only, no pack. */
export type Tier = 'verified' | 'generic';

/** A change joined to one usage of the changed symbol, with severity resolved for that usage. */
/** A local declaration several call sites trace back to: where one edit resolves them all. */
export interface SharedRoot {
  /** Declared name (`ref`). */
  name: string;
  file: string;
  line: number;
  /** Why it is the edit, as a clause: "whose parameter `ref: RefObject<HTMLElement>` no longer accepts ...". */
  reason: string;
}

export interface Finding {
  change: Change;
  usage: Usage;
  /** For a `cause` anchor: the errors it explains. The anchor itself is not a call site; these are. */
  downstream?: DownstreamSite[];
  /**
   * For a `cause` anchor that is a compiler option (`"jsx"` in a tsconfig): the anchor is the
   * one site to fix, and `downstream` is the evidence; it counts as one site, not as many.
   */
  anchorOnly?: true;
  /**
   * The repository declaration (a parameter, a prop) a compile error at a call site traces
   * to, repository-relative. On a call-site finding it says where the one edit is; sites in
   * different workspaces that share it are folded into one anchored finding at the
   * declaration (`anchorOnly`, the sites as `downstream`), which carries `root` too.
   */
  root?: SharedRoot;
  /**
   * For a `module-format` finding: every `require()` site of the package in this file, the
   * finding's own first. Switching a file to `import()` is one unit of work however many
   * lines load the package, so the finding stands for the file.
   */
  sites?: { line: number; snippet: string }[];
  /** May differ from `change.severity` once the direction of use is known (see architecture.md). */
  severity: Severity;
  /** `change.confidence` combined with usage certainty. */
  confidence: number;
  fixability: Fixability;
  reason: string;
  /** Set by the pack that produced the finding: the rule it belongs to, whatever its path says. */
  rule?: string;
  /** Lines the reader needs under the reason: changelog entries with the code they touch. */
  details?: string[];
  /** What confirms a breaking finding beyond the declaration diff; see `check/tier.ts`. */
  evidence?: 'compiler' | 'runtime' | 'module-format' | 'removed-export' | 'pack';
}

/**
 * `safe` means every site was analyzed and none is affected. `partial`: no finding, but
 * some sites (at most a fifth) could not be analyzed. `unknown`: more than a fifth of the
 * sites could not be analyzed, so no verdict is honest. `not-imported`: declared in
 * package.json but never imported by the repo's sources (skipped unless `allDeps`).
 * `workspace`: a `link:`/`workspace:`/`file:` dependency, nothing to upgrade. `private`:
 * the registry has no public record of it (auth or not published).
 */
export type PackageStatus =
  | 'breaking'
  | 'deprecated'
  | 'safe'
  | 'partial'
  | 'unknown'
  | 'no-types'
  | 'skipped'
  | 'not-imported'
  | 'workspace'
  | 'private';

/**
 * Findings grouped by migration rule, each with what `fix` will do about it. The split
 * between rule, agent and manual comes from a dry run of the pack's own transform, so `check`
 * and `fix` promise the same work.
 */
export interface PlanGroup {
  /** Stable rule id (`error-params`), or the change path when no pack rule covers it. */
  rule: string;
  /** Plain-English title for one terminal line. */
  title: string;
  severity: 'breaking' | 'unverified' | 'deprecated';
  /** Sites by who migrates them: a pack rule, the assisted fixer, or nobody (no pack). */
  by: { rule: number; agent: number; manual: number };
  /** Call sites or compile errors in this group. */
  sites: number;
  /** Edits expected: fewer than `sites` when one edit resolves several errors. */
  fixes: number;
  /** Repository-relative, in file and line order. */
  locations: { file: string; line: number }[];
  /** For deprecations: the deprecated names as written (`.email`) and their call counts. */
  symbols?: Record<string, number>;
  /** The first site's compiler message or reason, verbatim: for `--details`. */
  detail: string;
  /** One more line from the pack (stripe: API changes that touch the code). */
  note?: string;
}

export interface PackageReport {
  skipReason?: ErrorCode;
  /** Set on every report `check` returns. */
  tier?: Tier;
  /** The migration plan for the findings worth acting on; see `PlanGroup`. */
  plan?: PlanGroup[];
  /**
   * Internal: what a pack gathered per workspace for its plan notes (stripe's API versions and
   * usage evidence). Merged across workspaces, consumed by the plan, and removed before the
   * report is returned.
   */
  planContext?: {
    apiVersions?: { from: string; to: string };
    evidence?: {
      path: string;
      kind: 'method' | 'field' | 'param' | 'event';
      file: string;
      line: number;
    }[];
  };
  /** Workspace package this report belongs to, relative to the checked root (`.` for the root itself). */
  workspace: string;
  /** A dependency, or a release group (`@aws-sdk/*`) upgraded together; `members` lists the group. */
  name: string;
  members?: { name: string; installed: string; target: string }[];
  /**
   * What moves with the package `check` was asked about (`check/companions.ts`): its group at
   * the versions that agree with its target, each with why; `fix` upgrades them together.
   */
  companions?: { name: string; from: string; to: string; reason: string }[];
  /** Members of that group with no release that agrees with the target. */
  companionConflicts?: string[];
  /**
   * Packages left in place because their installed peer range rejects the target and nothing
   * moves them with it: `next-mdx-remote-client 1.1.2 declares react >= 18.3.0 < 19.0.0`.
   * Possible impact; never compiled at another version, never counted as breaking.
   */
  peerConflicts?: string[];
  /** Set when the entry merges several workspaces (`workspace` is then `*`). */
  workspaces?: string[];
  /**
   * This workspace imports the package without declaring it: it gets whatever Node resolution
   * finds (hoisted, or a workspace dependency's copy). `via` names the workspace dependency that
   * declares it, when one does.
   */
  undeclared?: { via?: string };
  /**
   * Every workspace that imports the package, declared or not, and whether it was analyzed. A
   * workspace that could not be analyzed is here with the reason; none is dropped silently.
   */
  importers?: Importer[];
  /** `catalog`: the version is pinned in the workspace's pnpm catalog, one decision for every package. */
  source?: 'catalog';
  /** Types come from DefinitelyTyped: `@types/express 4.17.21 → 5.0.3`, the versions that were diffed. */
  typesVia?: string;
  installed: string;
  latest: string;
  target: string;
  majorsBehind: number;
  findings: Finding[];
  /** Total usages of this package found, affected or not. */
  callSitesChecked: number;
  /** Sites the analyzer could not follow (`require`, `import =`, dynamic `import()`). */
  unanalyzed: Unanalyzed[];
  status: PackageStatus;
  /** Signal B summary, when it ran. */
  compile?: {
    baselineErrors: number;
    skipped?: string;
    unresolvedInTarget: string[];
    unresolvedFiles: string[];
    /** Errors the upgrade causes that no change explains. */
    unattributed: CompileDiagnostic[];
    /** New type errors at the target: every error the upgrade causes, explained or not. */
    newErrors?: number;
    /**
     * How many of the files that use the package were type-checked against the target, over
     * how many workspaces, and why the rest were not: `compiled 12 of 40 files in 2 workspaces`.
     */
    coverage?: CompileCoverage & { workspaces: number };
  };
  /**
   * The breaking count and what verified it, for every analyzed package, zero included:
   * `0 breaking · compiled against 4.6.5: 0 new type errors`, or `types not verified: <why>`.
   */
  verdict?: {
    breaking: number;
    compiledAgainst?: string;
    newErrors?: number;
    notVerified?: string;
    /** Set when some, not all, of the files were compiled: `compiled 12 of 40 files in 2 workspaces; skipped: ...`. */
    partlyVerified?: string;
    summary: string;
  };
  /** Signal C: what loading installed and target in a child Node showed, one entry per member. */
  runtime?: RuntimeReport[];
  /** One-line remarks the human report prints under the package (skips, gaps). */
  notes: string[];
  timing: {
    fetchMs: number;
    diffMs: number;
    usagesMs: number;
    compileMs: number;
    runtimeMs?: number;
  };
}

export interface Importer {
  workspace: string;
  declared: boolean;
  /** The workspace dependency the undeclared import resolves through, when there is one. */
  via?: string;
  analyzed: boolean;
  reason?: string;
}

export interface RuntimeReport {
  package: string;
  /** The Node that loaded both copies (`v22.20.0`), and whether it is the repository's or uptide's own. */
  node: string;
  nodeSource: 'repository' | 'current';
  changes: RuntimeChange[];
  /** Export keys reached by Signal A; controls runtime notes, not arbitration. */
  usedKeys?: string[];
  /** What `require()` of the target returned, for the per-site shape rules of module-format findings. */
  targetRequire?: RuntimeLoad;
  /** Why nothing could be concluded (native addon, a dependency the sandbox could not provide). */
  inconclusive?: string;
}

export interface CheckReport {
  repo: string;
  /** Workspace packages checked, relative to `repo`; `['.']` for a single-package repository. */
  workspaces: string[];
  packages: PackageReport[];
  summary: {
    packagesNeedingAttention: number;
    breaking: number;
    deprecated: number;
    /** Findings the compiler could not judge (unresolved imports in the target's declaration file). */
    unverified: number;
    /** Dependencies (deduplicated by name across workspaces) with no breaking or deprecated finding. */
    unaffected: number;
    /** Packages declared but never imported, not analyzed. */
    notImported: number;
    /** Packages with no finding whose sites were not all analyzed (`partial` and `unknown`). */
    partiallyAnalyzed: number;
    autoFixable: number;
    /** Dependencies behind that the time budget did not reach (`--max-time`). */
    skippedForTime: number;
    /** Dependencies whose analysis failed (registry error, install or analysis failure). */
    failed: number;
  };
}
