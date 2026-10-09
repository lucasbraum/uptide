import type { ChangeKind } from '../domain/change.js';
import type { Finding } from '../domain/report.js';
import type { Usage } from '../domain/usage.js';

export interface MigrationEvidence {
  path: string;
  kind: 'method' | 'field' | 'param' | 'event';
  file: string;
  line: number;
  /**
   * The compiler reported an error at this site against the target version: the change is
   * real here, so a changelog entry that names the member explains it.
   */
  compiler?: true;
}
/** A helper several migrated files need, placed once where every one of them can import it. */
export interface SharedHelper {
  name: string;
  /** Repository-relative file that now exports it. */
  file: string;
  /** How each workspace imports it: the package name through a `workspace:` dependency, or a relative path. */
  specifiers: Record<string, string>;
}
export interface PackContext {
  from: string;
  to: string;
  includeDeprecated: boolean;
  /** Helpers the run placed before assisting: the agent imports them, never redefines them. */
  helpers?: SharedHelper[];
  usagePaths?: string[];
  evidence?: MigrationEvidence[];
  eventTypes?: string[];
  apiVersions?: { from: string; to: string };
  /** `api_version` literals in payload objects (webhook fixtures), with where they are. */
  payloadVersions?: { file: string; line: number; value: string }[];
  /** Places that depend on the dependency's default messages, which the target words differently. */
  defaultMessages?: DefaultMessageSite[];
}
/** What a provider's API changelog says between the two pinned API versions, against this code. */
export interface ApiChangeFacts {
  from: string;
  to: string;
  /** Changelog entries between the two versions. */
  total: number;
  /** Entries with concrete evidence in the code (a method, field, parameter or event it uses). */
  relevant: number;
  /** Entries the provider marks breaking, relevant or not. */
  breaking: number;
  /** Entries that change a resource the code uses without naming anything it calls or reads. */
  resources?: { total: number; breaking: number; names: string[] };
}
/** A string literal that is one of the dependency's old default messages. */
export interface DefaultMessageSite {
  /** Repository-relative. */
  file: string;
  line: number;
  /** The old default message as written in the code. */
  text: string;
  /** What the target version says instead, in words. */
  now: string;
  /** The text to match instead, when it is certain whatever the schema is. */
  replacement?: string;
}
export interface FollowUp {
  /** Repository-relative. */
  file: string;
  line: number;
  before: string;
  after: string;
  reason: string;
  /** Edits in the same file the main one needs: the import of a name it now uses. */
  also?: { line: number; before: string; after: string }[];
  /** The rule a test follow-up belongs to (`subscription-period`); default-messages when absent. */
  rule?: string;
}
export interface TransformResult {
  text: string;
  applied: boolean;
  reason: string;
  rule?: string;
}
export interface MigrationRule {
  id: string;
  kinds: readonly ChangeKind[];
  symbols: RegExp;
  guide: string;
  /**
   * One edit at the declaration resolves the file's other diagnostics of this rule (a generic
   * signature, a removed type import). `check` then plans one fix per file, and compiler-only
   * errors in that file fold into the rule instead of standing alone.
   */
  perFile?: boolean;
}
/** Packs own dependency knowledge. The runner owns git, verification, and publication. */
/** A package a pack says always moves with its own, and the official page that says so. */
export interface PackCompanion {
  name: string;
  /** An `https` URL to the official migration guide or changelog that says it moves with the leader. */
  source: string;
}

export interface MigrationPack {
  readonly name: string;
  /**
   * Packages that always move with this one, even when the installed version of each already
   * accepts the target. Each carries the `source` that says so: the URL of an official
   * migration guide or changelog (the package's own, when the leader's does not name it).
   * Release-group members published at the target's own version (`react-dom`) and `@types/*`
   * need no entry.
   */
  readonly companions?: readonly PackCompanion[];
  readonly defaultTarget: string;
  readonly rules: readonly MigrationRule[];
  supports(from: string, to: string): boolean;
  transform(text: string, finding: Finding, context: PackContext): TransformResult;
  guide(finding: Finding, context?: PackContext): string;
  /**
   * The rule a reported site belongs to, when the pack can say so itself: the plan files the
   * site under it whether or not the rule rewrites. Packs built with `definePack` answer from
   * their rules; without it the plan classifies by the change (`changeRule`).
   */
  ruleOf?(finding: Finding): string | undefined;
  reviewNotes(context: PackContext): string[];
  validateAssisted?(
    text: string,
    finding: Finding,
    explanation: string,
    original?: string,
    context?: PackContext,
  ): string | undefined;
  /**
   * Helpers to place once, before assisting, where every migrated file can import them:
   * the edits (a declaration appended to a shared module, its re-export), and how each
   * workspace imports the name. Applied by rule and committed; the agent then imports.
   */
  sharedHelpers?(input: {
    root: string;
    workspaces: string[];
    findings: Finding[];
    context: PackContext;
  }): {
    helper: SharedHelper;
    /** The whole new text of each file; `line` is where the change starts, the end of the file when absent. */
    edits: { file: string; text: string; line?: number }[];
  }[];
  resolveContext?(context: PackContext): Promise<PackContext>;
  /**
   * Review material for the PR. `rules` are the rule ids of this run's own sites: a section
   * about a rule appears only when the run has such a site, so nothing written for one
   * repository shows up in another's PR.
   */
  reviewSections?(
    context: PackContext,
    rules?: readonly string[],
  ): {
    title: string;
    lines: string[];
    lists?: { summary: string; items: string[]; more: string }[];
  }[];
  /**
   * Edits that must follow an accepted site edit and that no compiler error points at: a test
   * asserting the old value of a constant the site changed. Deterministic text replacements,
   * each one line, reported as their own sites.
   */
  followUps?(input: {
    root: string;
    workspaces: string[];
    /** The site as it was before the edit: its file, line and snippet. */
    finding: Finding;
    context: PackContext;
  }): FollowUp[];
  /** Facts gathered from the repository's files before anything is changed. */
  scanContext?(root: string, workspaces: string[]): Partial<PackContext>;
  /**
   * Edits for test files the migrated code made fail, when the cause is a known behaviour
   * change no compiler error shows (reworded default messages). `failing` are the test files
   * as the runner printed them. The tests run again afterwards: the repository's own suite
   * decides whether the edit was right.
   */
  testFollowUps?(input: {
    root: string;
    workspaces: string[];
    failing: string[];
    /** What the runner printed, for what it says about why. */
    output?: string;
    context: PackContext;
  }): FollowUp[];
  /** The API changelog between the pinned versions, counted against the code's evidence. */
  apiChanges?(context: PackContext): ApiChangeFacts | undefined;
  /** Choices only the owner can make, from facts found in this repository (top of the PR body). */
  decisions?(
    context: PackContext,
    rules: readonly string[],
    /** Follow-up edits this run made, by rule: what was changed, where. */
    followed?: { rule: string; file: string; line: number; before: string; after: string }[],
  ): string[];
  /**
   * What `planNote` needs, from what `check` already has in hand for one workspace: both
   * copies on disk and the usages it scanned. No second scan, no network.
   */
  planContext?(input: {
    root: string;
    workspace: string;
    installedDir: string;
    targetDir: string;
    usages: Usage[];
  }): Pick<PackContext, 'apiVersions' | 'evidence'>;
  /** One line under a planned rule in `check` (stripe: how many API changes touch the code). */
  planNote?(rule: string, context: PackContext): string | undefined;
  /**
   * Findings no diff of the types produces: a client the SDK bump reconfigures at runtime
   * (`new Stripe(key)` with no `apiVersion`). Fed like `planContext`, from what `check`
   * already has for one workspace; `read` gives a repository file's text, relative to root.
   */
  /**
   * The words for a pack's own finding once the whole repository's evidence is in hand
   * (`planContext`, merged across workspaces): a client created in one workspace speaks for
   * the fields every workspace reads.
   */
  describeFinding?(
    finding: Finding,
    context: PackContext,
  ): Pick<Finding, 'reason' | 'details'> | undefined;
  runtimeFindings?(input: {
    root: string;
    workspace: string;
    from: string;
    to: string;
    installedDir: string;
    targetDir: string;
    usages: Usage[];
    read: (file: string) => string | undefined;
  }): Finding[];
}
