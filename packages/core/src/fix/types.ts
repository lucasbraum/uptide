import type { Finding, Tier } from '../domain/report.js';
import type { Provider } from '../llm/types.js';
import type { ApiChangeFacts, PackContext } from '../packs/types.js';
import type { BehaviorResult } from './behavior.js';
import type { InstallReport } from './managers/upgrade.js';
import type { PeerBlockerGroup } from './peer-preflight.js';
export interface FixDiagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
  /**
   * TS2322/TS2345: the shape of the type the compiler expected, one level deep
   * (`BillingCycleAnchor: { type: "now" | "unchanged" | OtherString }`). The message names
   * the type; a migration needs what it is.
   */
  expected?: string;
}
export interface FixSite {
  finding: Finding;
  outcome: 'mechanical' | 'agent' | 'manual';
  reason: string;
  /** Stable migration rule, retained for grouping without compiler-code heuristics. */
  rule?: string;
  diff?: string;
  /** Site key of the accepted edit that also resolved this diagnostic. */
  resolvedBy?: string;
  attempts?: AssistedAttempt[];
}
export type LlmFailureKind =
  | 'no-tool-call'
  | 'invalid-tool-call'
  | 'rate-limited'
  | 'api-error'
  | 'usage-unavailable'
  | 'token-bounds';
export interface AssistedAttempt {
  responseModel?: string;
  reservationUsd?: number;
  unreportedCostUsd?: number;
  failureKind?: LlmFailureKind;
  durationMs?: number;
  attempt: number;
  outcome: 'accepted' | 'reverted';
  before: FixDiagnostic[];
  after: FixDiagnostic[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  explanation: string;
  diff?: string;
}
export interface TestResult {
  /** The workspace the run is reported under; a shared configuration reports under its directory. */
  workspace: string;
  status: 'passed' | 'failed' | 'missing' | 'timeout';
  output: string;
  /** What ran, as typed from the run's directory. Absent when nothing could be run. */
  command?: string;
  /** How the scope was chosen: a script, the tests related to the affected files, a directory. */
  scope?: string;
  /** Workspaces this run answers for. */
  covers?: string[];
  /** `270 tests in 41 files`, when the runner printed its counts. */
  summary?: string;
  /** Integration and end-to-end test files left out because they need services (the default). */
  notRun?: { files: number; needs: string[] };
  /** With `--with-services`: the services the run was allowed to reach, and where. */
  services?: { names: string[]; targets: string[] };
  /**
   * Test files that failed on the first attempt and passed when the run was repeated once. Only
   * failures outside the affected files are retried: those are the flaky ones, not ours.
   */
  retried?: string[];
  /**
   * The run failed, but the same test files failed before anything changed (a missing generated
   * client, a service the tests expect): the repository's problem, not the migration's. The
   * files, or `['*']` when the runner named none.
   */
  preexisting?: string[];
}
/** The repository's own lint (biome, prettier, eslint) run on the files the migration edited. */
export interface LintResult {
  tool: string;
  /** `pre-existing`: it fails now and failed on the same files before the migration. */
  status: 'passed' | 'failed' | 'pre-existing';
  command: string;
  /** How many files it was run on. */
  files: number;
  /** What the tool printed when it did not pass. */
  output: string;
}
export interface FixRequest {
  finding: Finding;
  guide: string;
  enclosingFunction: string;
  source: string;
  compilerError: string;
  retry?: string;
}
export interface FixResponse {
  responseModel?: string;
  reservationUsd?: number;
  failureKind?: LlmFailureKind;
  retryAfterMs?: number;
  failure?: string;
  halt?: boolean;
  /** Budget retained for a call whose API did not report usage. */
  unreportedCostUsd?: number;
  diff: string;
  explanation?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}
export interface Fixer {
  readonly id: string;
  readonly provider?: Provider;
  /** Worst-case USD reservation, including the output cap. Required for budgeted calls. */
  estimate?(input: FixRequest): number;
  fix(input: FixRequest, remainingUsd?: number): Promise<FixResponse>;
}
export interface FixReport {
  peerConflicts?: PeerBlockerGroup[];
  /** `generic`: no pack covers the upgrade; every edit is the agent's, verified by the compiler. */
  tier?: Tier;
  lockfile?: InstallReport;
  repo: string;
  package: string;
  target: string;
  /** Where the target came from: asked for, the npm `latest` dist-tag, or the pack's tested target offline. */
  targetSource?: 'requested' | 'latest on npm' | "the pack's tested target";
  from?: string;
  /** What moved with it, at the versions that agree with the target, and why (`check/companions.ts`). */
  companions?: { name: string; from: string; to: string; reason: string }[];
  /** `pin`: no upgrade; the SDK's default API version was written on every client (`--pin-current-api`). */
  mode?: 'pin';
  /** The API version the pin run wrote. */
  apiVersion?: string;
  uptideVersion?: string;
  uptideCommit?: string;
  uptideDirty?: boolean;
  verifiedAt?: string;
  verificationTimingMs?: number;
  head?: string;
  verificationPending?: boolean;
  branch: string;
  sites: FixSite[];
  /** Generated code produced in the clone before the baseline (a Prisma client), per workspace. */
  generated?: {
    workspace: string;
    command: string;
    status: 'generated' | 'failed' | 'timeout';
    output?: string;
  }[];
  verification: {
    baseline: FixDiagnostic[];
    target: FixDiagnostic[];
    after: FixDiagnostic[];
    newErrors: FixDiagnostic[];
    baselineTests: TestResult[];
    tests: TestResult[];
    /** Lint of the edited files with the repository's own tools; a new failure fails verification. */
    lint?: LintResult[];
    /** Formatters run on the edited files (`biome`, `prettier`), when any changed them. */
    formatted?: string[];
    passed: boolean;
    /** Set when the baseline could not see packages the repository installs: no type verdict holds. */
    typesUnverified?: string;
    workspaceTypes?: { workspace: string; errors: number }[];
  };
  llm: {
    provider?: Provider;
    model?: string;
    /** Worst-case reservation for calls with no trustworthy usage. Not reported spend. */
    unreportedCostUsd?: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    available: boolean;
    disabled?: boolean;
    /** Set when `--max-cost` stopped the agent: the limit and unfinished sites (including stopped retries). */
    costLimit?: { limitUsd: number; notAttempted: number };
  };
  timingMs: number;
  prBody: string;
  /** The migration report as a page, written by the CLI next to the stored run. */
  html?: string;
  /** The branch the user's checkout was on when the run started: what the migration branch is against. */
  base?: string;
  /** `--base`: the branch the PR is opened against, when not the target repository's default. */
  prBase?: string;
  prUrl?: string;
  /** Set when `--pr` was asked for and refused: why nothing was pushed. The branch stays local. */
  /** What the publish step printed (the plan, warnings): shown by the caller once nothing else is drawing. */
  publicationLog?: string;
  publication?: {
    refused: string[];
    /** The publish step itself failed (push, `gh`): the run is in the repository, `uptide pr` retries. */
    failed?: string;
  };
  notes: string[];
  behavior?: BehaviorResult[];
  reviewSections?: ReviewSection[];
  /** What the pack knew about this repository (versions, evidence): review material is made from it. */
  packContext?: PackContext;
  /** The provider's API changelog between the pinned versions, counted against this code. */
  apiChanges?: ApiChangeFacts;
  /** Pack-provided decisions from facts of this repository, rendered under "Decisions for you". */
  decisions?: string[];
  /** The user's checkout the run was made for; `repo` is the private clone it ran in. */
  source?: string;
  /** The temporary clone the run used: removed when no longer needed, kept (with why) otherwise. */
  clone?: { path: string; kept: boolean; reason?: string };
  /** What changed in the user's checkout during the run. Never expected; blocks publication. */
  sourceChanged?: string[];
  /** `origin` of the repository the run belongs to, normalized to its https URL. */
  remote?: string;
}

/** Review material from a pack: lines always shown, and lists that may be shortened to fit. */
export interface ReviewSection {
  title: string;
  lines: string[];
  /**
   * Long lists, most important first (a changelog: breaking entries first). In a PR body
   * they lose items from the end when the body would exceed GitHub's limit; `more` is the
   * line that stands for what is left out, `{n}` its count. The migration page has them all.
   */
  lists?: { summary: string; items: string[]; more: string }[];
}
