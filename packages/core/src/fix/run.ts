import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { type CheckOptions, check } from '../check/check.js';
import { compareVersions } from '../check/version.js';
import { type ProgressListener, progress } from '../domain/progress.js';
import type { CheckReport, Finding } from '../domain/report.js';
import { UptideError } from '../errors.js';
import { ACCEPTED_KEYS, selectLlm } from '../llm/config.js';
import { DEFAULT_MAX_COST_USD, providerFixer } from '../llm/fixer.js';
import { genericPack } from '../packs/generic.js';
import { stripePack } from '../packs/stripe/index.js';
import { payloadApiVersions, stripeUsageContext } from '../packs/stripe/relevance.js';
import type { MigrationPack, PackContext } from '../packs/types.js';
import { zodPack } from '../packs/zod/index.js';
import { resetSharedState } from '../shared-state.js';
import { UPTIDE_COMMAND, uptideVersionInfo } from '../version.js';
import { assist } from './assisted.js';
import { behaviorCheck } from './behavior.js';
import { type Generated, generateClients } from './generate.js';
import { assertManagerAvailable } from './managers/availability.js';
import type { InstallReport, Upgrade } from './managers/upgrade.js';
import { pinCurrentApi } from './pin.js';
import { command, git, projectRoot } from './process.js';
import { publicationBlockers } from './publish.js';
import { changeRule, editDiff, prBody } from './report.js';
import { selectedFindings } from './select.js';
import { applyFollowUps, commit, type Followed, safeFile, settle } from './settle.js';
import { lintFiles } from './style.js';
import { resolveTarget } from './target.js';
import type { FixDiagnostic, Fixer, FixReport, FixSite, LintResult, TestResult } from './types.js';
import {
  describeServices,
  diagnostics,
  markPreexisting,
  newDiagnostics,
  type TestOptions,
  testWorkspaces,
  typeResolutionFailure,
} from './verify.js';
import { bumpVersions, install, packageManager } from './versions.js';

export interface FixOptions {
  onProgress?: ProgressListener;
  cwd: string;
  provider?: string;
  model?: string;
  /** Any direct dependency: one with a pack (zod, stripe) or, with the agent, any other. */
  only: string;
  target?: string;
  includeDeprecated?: boolean;
  pr?: boolean;
  yes?: boolean;
  fixer?: Fixer | null;
  testTimeoutMs?: number;
  pack?: MigrationPack;
  /**
   * Also run tests that need a database, a cache or a queue. Off by default; with it, `yes`
   * must confirm the services and connection targets that were printed.
   */
  withServices?: boolean;
  /**
   * stripe only: no upgrade. Write the installed SDK's default API version on every client
   * created without `apiVersion`: zero behaviour change, the smallest PR.
   */
  pinCurrentApi?: boolean;
  /**
   * Reserve the worst-case cost before every call/retry. Sites that cannot finish stay
   * manual and the run says so. Default: 1 USD for every package.
   */
  maxCostUsd?: number;
  /** The build doing the work; injected by tests, which run from a checkout under development. */
  tool?: ReturnType<typeof uptideVersionInfo>;
}
/** Small I/O seams let tests exercise the real transaction without registry or an LLM. */
export interface FixServices {
  check(options: CheckOptions): Promise<CheckReport>;
  // biome-ignore lint/suspicious/noConfusingVoidType: injected installers may deliberately return no report
  install(root: string, upgrade?: Upgrade): Promise<InstallReport | void>;
  diagnostics(root: string, workspaces: string[]): FixDiagnostic[];
  /** `files`: repository-relative paths the migration touches, to scope the run to related tests. */
  tests(
    root: string,
    workspaces: string[],
    timeoutMs?: number,
    files?: string[],
    options?: TestOptions,
  ): Promise<TestResult[]>;
  /** The repository's formatter on these files only; returns the formatters that ran. */
  format?(root: string, files: string[]): Promise<string[]>;
  /** The repository's lint on these files; `baseline` marks failures that were already there. */
  lint?(root: string, files: string[], baseline?: LintResult[]): Promise<LintResult[]>;
  /** Generated code the repository needs before it can be measured (a Prisma client). */
  generate?(root: string, workspaces: string[]): Promise<Generated[]>;
  /** A dist-tag to an exact version (`latest`); the registry by default. */
  resolve?(name: string, tag: string): Promise<string>;
  /** The publish step of a `--pr` run; `publishVerified` by default. */
  publish?(
    result: FixReport,
    options: { tool: { uptideDirty: boolean }; yes?: boolean; cwd?: string },
  ): Promise<void>;
}
const defaults: FixServices = { check, install, diagnostics, tests: testWorkspaces };
/**
 * `--with-services` runs the repository's tests against whatever its setup connects to. That is
 * never done on a guess: the services and targets are named, and `--yes` has to confirm them.
 */
export function confirmServices(
  root: string,
  options: { withServices?: boolean; yes?: boolean },
): void {
  if (!options.withServices || options.yes) return;
  const reach = describeServices(root, workspacePackagesOf(root));
  if (reach.length === 0) return;
  throw new UptideError(
    'SERVICES_NOT_CONFIRMED',
    `--with-services would run tests against:\n${reach.map((l) => `  ${l}`).join('\n')}\nNothing ran. Add --yes to confirm these services and run.`,
  );
}
/** `git@github.com:owner/repo.git` and its https form are the same repository. */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://');
}
function originOf(root: string): string | undefined {
  try {
    return normalizeRemote(git(root, 'remote', 'get-url', 'origin')) || undefined;
  } catch {
    return undefined;
  }
}
/** Compatibility alias: the same default now applies to all packages. */
export const GENERIC_MAX_COST_USD = DEFAULT_MAX_COST_USD;
/**
 * One package's migration. A failure leaves no shared TypeScript state behind: whatever a
 * caller runs next in this process (the Action fixes each detected upgrade in turn) starts
 * as in a new process (shared-state.ts).
 */
export async function fix(
  options: FixOptions,
  services: FixServices = defaults,
): Promise<FixReport> {
  try {
    return await fixPackage(options, services);
  } catch (err) {
    resetSharedState();
    throw err;
  }
}

async function fixPackage(options: FixOptions, services: FixServices): Promise<FixReport> {
  const started = Date.now();
  const root = realpathSync(resolve(options.cwd));
  if (
    options.maxCostUsd !== undefined &&
    (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)
  )
    throw new Error('--max-cost must be a positive finite amount in USD');
  const selection = selectLlm(root, options);
  let pack =
    options.pack ??
    [zodPack, stripePack].find((p) => p.name === options.only) ??
    genericPack(options.only);
  if (pack.name !== options.only) throw new Error(`no migration pack for ${options.only}`);
  const fixer = options.fixer === null ? undefined : (options.fixer ?? providerFixer(selection));
  // Without a pack every edit is the agent's: no agent, nothing this command can do.
  const needsAgent = (candidate: MigrationPack): void => {
    if (candidate.rules.length === 0 && !fixer)
      throw new UptideError(
        'NO_FIXER',
        `${candidate.name} has no migration pack, so every fix would come from the agent, and ${options.fixer === null ? 'assisted fixes are off (--no-llm)' : `no selected-provider API key is set; accepted environment variables: ${ACCEPTED_KEYS}`}`,
      );
  };
  needsAgent(pack);
  projectRoot(root);
  if (git(root, 'status', '--porcelain', '--untracked-files=all'))
    throw new UptideError('DIRTY_WORKING_TREE', 'uptide fix requires a clean working tree');
  confirmServices(root, options);
  if (options.pinCurrentApi) return pinCurrentApi(options, services, originOf);
  const tool = options.tool ?? uptideVersionInfo();
  // A PR records the Uptide commit that produced it; uncommitted changes make that a lie.
  if (options.pr && tool.uptideDirty)
    throw new UptideError(
      'DIRTY_UPTIDE_TREE',
      `uptide fix --pr refuses to run from an Uptide checkout with uncommitted changes (at ${tool.uptideCommit.slice(0, 12)}); commit or stash them, rebuild, and run again`,
    );
  const resolved = await resolveTarget(pack, options.target, services.resolve);
  const target = resolved.version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target))
    throw new Error('target must be an exact version');
  const branch = `uptide/${pack.name}-${target}`;
  packageManager(root);
  if (services.install === install) await assertManagerAvailable(root);
  const report = await services.check({
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    cwd: root,
    only: [pack.name],
    targets: { [pack.name]: target },
    runtime: false,
    plan: false,
    workspaceConcurrency: 1,
  });
  const packages = report.packages.filter(
    (p) => p.name === pack.name && !p.notes.includes('up to date'),
  );
  if (!packages.length) throw new Error(`${pack.name} has no upgrade to ${target}`);
  // A pack that does not cover this upgrade (zod 4 → 4) leaves it to the generic path.
  if (!options.pack && packages.some((p) => !pack.supports(p.installed, target))) {
    pack = genericPack(options.only);
    needsAgent(pack);
  }
  const generic = pack.rules.length === 0;
  for (const p of packages) {
    if (!pack.supports(p.installed, target))
      throw new Error(`${pack.name} pack does not support ${p.installed} → ${target}`);
    if (
      ['skipped', 'no-types', 'private', 'unknown', 'partial'].includes(p.status) ||
      p.compile?.skipped ||
      p.unanalyzed.length
    )
      throw new UptideError(
        p.skipReason ?? 'INCOMPLETE_CHECK',
        `cannot fix an incomplete check: ${p.name} ${p.notes.join('; ')}`,
      );
  }
  const initialContext = {
    from:
      [...packages].sort((a, b) => compareVersions(a.installed, b.installed))[0]?.installed ?? '',
    to: target,
    includeDeprecated: options.includeDeprecated ?? false,
  };
  let packContext: PackContext = pack.resolveContext
    ? await pack.resolveContext(initialContext)
    : initialContext;

  // Workspaces that declare the package, and those that import it without declaring it and
  // were analyzed: their sites are in the report, so their types and tests are verified too.
  const importers = new Set(
    packages.flatMap((p) => (p.importers ?? []).filter((i) => i.analyzed).map((i) => i.workspace)),
  );
  const workspaces = workspacePackagesOf(root).filter((w) => {
    const p = JSON.parse(readFileSync(join(root, w, 'package.json'), 'utf8'));
    return (
      importers.has(w) ||
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
        (s) => typeof p[s]?.[pack.name] === 'string',
      )
    );
  });
  if (pack.name === 'stripe')
    packContext = {
      ...packContext,
      ...(await stripeUsageContext(root, workspaces, initialContext.from)),
      payloadVersions: payloadApiVersions(root, workspaces),
    };
  if (pack.scanContext) packContext = { ...packContext, ...pack.scanContext(root, workspaces) };
  // Validate checked-in knowledge before any version or source write.
  pack.reviewSections?.(packContext);
  const verify = <T>(detail: string, work: () => T | Promise<T>): Promise<T> =>
    progress(options.onProgress, { phase: 'verify', package: pack.name, detail }, work);
  const names = (list: string[]): string =>
    list.map((w) => (w === '.' ? 'root' : (w.split('/').pop() ?? w))).join(', ');
  // What the repository's own types and tests need generated, before anything is measured.
  const generated = await verify('generate', () =>
    (services.generate ?? generateClients)(root, workspaces),
  );
  const baseline = await verify(`types (${names(workspaces)})`, () =>
    services.diagnostics(root, workspaces),
  );
  // The same scope before and after: the files with reported sites decide which tests relate.
  // Without a pack only what has evidence is migrated: an unconfirmed site is not the agent's.
  const selected = selectedFindings(report, pack.name, options.includeDeprecated ?? false).filter(
    (f) => !generic || f.severity === 'breaking',
  );
  const affected = [...new Set(selected.map((f) => f.usage.file))];
  // Evidence at a site the compiler rejected is confirmed evidence: the change is real there.
  if (packContext.evidence)
    packContext = { ...packContext, evidence: confirmedEvidence(packContext.evidence, selected) };
  const baselineTests = await verify(`tests (${names(workspaces)})`, () =>
    services.tests(root, workspaces, options.testTimeoutMs, affected, {
      withServices: options.withServices === true,
    }),
  );
  if (git(root, 'status', '--porcelain', '--untracked-files=all'))
    throw new Error('baseline tests modified the working tree; review their changes before fixing');
  // Lint of the same files before anything changes: a failure that is already there is not ours.
  const baselineLint = await (services.lint ?? lintFiles)(root, affected);
  git(root, 'switch', '-c', branch);
  const bump = bumpVersions(root, pack.name, target);
  const lockfile = await progress(
    options.onProgress,
    { phase: 'install', package: pack.name, detail: `${pack.name} ${target}` },
    () =>
      services.install(root, {
        name: pack.name,
        version: target,
        workspaces: bump.workspaces,
        files: bump.files.map((f) => relative(root, f)),
      }),
  );
  commit(root, `chore: upgrade ${pack.name} to ${target}`, [
    ...bump.files,
    join(root, packageManager(root).lockfile),
  ]);
  // The install replaced node_modules, and what was generated into it with them.
  if (generated.length)
    await verify('generate', () => (services.generate ?? generateClients)(root, workspaces));
  const targetErrors = await verify(`types (${names(workspaces)})`, () =>
    services.diagnostics(root, workspaces),
  );
  const sites: FixSite[] = [];
  const changed = new Set<string>();
  const rulesStarted = performance.now();
  options.onProgress?.({ phase: 'rules', package: pack.name, state: 'start' });
  const originals = new Map<string, string>();
  for (const finding of selected) {
    const file = safeFile(root, finding.usage.file);
    const original = readFileSync(file, 'utf8');
    if (!originals.has(finding.usage.file)) originals.set(finding.usage.file, original);
    const result = pack.transform(original, finding, {
      ...packContext,
      from: finding.change.from,
      to: target,
      includeDeprecated: options.includeDeprecated ?? false,
    });
    if (result.applied) {
      writeFileSync(file, result.text);
      changed.add(file);
    }
    const site: FixSite = {
      finding,
      outcome: result.applied ? 'mechanical' : 'manual',
      reason: result.reason,
      ...(result.applied ? { diff: editDiff(original, result.text) } : {}),
    };
    site.rule = result.rule ?? changeRule({ package: pack.name }, site);
    sites.push(site);
  }
  options.onProgress?.({
    phase: 'rules',
    package: pack.name,
    state: 'done',
    ms: performance.now() - rulesStarted,
  });
  commit(root, `fix(${pack.name}): apply mechanical migrations`, [...changed]);
  // A helper several sites need is placed once, by rule, where every site can import it; the
  // agent then imports. One file written, its barrels updated, verified with the sites.
  for (const { helper, edits } of pack.sharedHelpers?.({
    root,
    workspaces,
    findings: selected,
    context: packContext,
  }) ?? []) {
    const files: string[] = [];
    // The site the helper answers for: a period read, whose rule the helper edit joins.
    const base =
      selected.find((f) => /current_period_(?:start|end)/.test(f.change.path)) ??
      selected.find((f) => /current_period_(?:start|end)/.test(f.usage.compileError ?? '')) ??
      (selected[0] as Finding);
    for (const edit of edits) {
      const file = safeFile(root, edit.file);
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, edit.text);
      files.push(file);
      sites.push({
        finding: {
          ...base,
          usage: {
            ...base.usage,
            file: edit.file,
            line: edit.line ?? original.split('\n').length,
            column: 1,
            endLine: edit.text.split('\n').length,
            endColumn: 1,
            snippet: `${helper.name} shared from ${helper.file}`,
          },
        },
        outcome: 'mechanical',
        reason:
          edit.file === helper.file
            ? `${helper.name} placed here once, where every migrated file imports it`
            : `re-exports ${helper.name} so the sites can import it`,
        diff: editDiff(original, edit.text),
        rule: changeRule(
          { package: pack.name },
          { finding: base, outcome: 'mechanical', reason: '' },
        ),
      });
      if (!affected.includes(edit.file)) affected.push(edit.file);
    }
    commit(root, `fix(${pack.name}): add ${helper.name} to ${helper.file}`, files);
    packContext = { ...packContext, helpers: [...(packContext.helpers ?? []), helper] };
  }
  const llm = await progress(options.onProgress, { phase: 'assist', package: pack.name }, () =>
    assist(
      root,
      sites,
      pack,
      fixer,
      () => services.diagnostics(root, workspaces),
      packContext,
      options.fixer === null,
      options.onProgress,
      { maxCostUsd: options.maxCostUsd ?? DEFAULT_MAX_COST_USD },
    ),
  );
  const followed: Followed[] = [];
  // Edits no compiler error points at: a test asserting the old value of a changed constant.
  for (const site of [...sites]) {
    if (site.outcome === 'manual' || !pack.followUps) continue;
    applyFollowUps({
      root,
      pack: pack.name,
      edits: pack.followUps({ root, workspaces, finding: site.finding, context: packContext }),
      base: site.finding,
      rule: site.rule,
      origin: `${site.finding.usage.file}:${site.finding.usage.line}`,
      sites,
      followed,
      affected,
    });
  }
  const behavior = pack.name === 'zod' ? behaviorCheck(root, originals, sites) : undefined;
  const {
    tests: ran,
    after,
    lint,
    formatted,
  } = await settle({
    root,
    pack,
    context: packContext,
    workspaces,
    sites,
    followed,
    affected,
    from: initialContext.from,
    target,
    baselineLint,
    services,
    withServices: options.withServices === true,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const tests = markPreexisting(ran, baselineTests);
  const pending = git(root, 'status', '--porcelain', '--untracked-files=all');
  const newErrors = newDiagnostics(baseline, after);
  const unverified = typeResolutionFailure(root, baseline);
  const result: FixReport = {
    ...(lockfile ? { lockfile } : {}),
    ...(generated.length ? { generated } : {}),
    repo: root,
    package: pack.name,
    tier: generic ? 'generic' : 'verified',
    from: initialContext.from,
    target,
    targetSource: resolved.source,
    ...tool,
    verifiedAt: new Date().toISOString(),
    head: git(root, 'rev-parse', 'HEAD'),
    branch,
    sites,
    verification: {
      baseline,
      target: targetErrors,
      after,
      newErrors,
      baselineTests,
      tests,
      ...(lint.length ? { lint } : {}),
      ...(formatted.length ? { formatted } : {}),
      ...(unverified ? { typesUnverified: unverified } : {}),
      passed:
        !unverified &&
        newErrors.length === 0 &&
        !pending &&
        tests.every((t) => t.status === 'passed' || t.status === 'missing' || t.preexisting) &&
        lint.every((l) => l.status !== 'failed'),
    },
    llm,
    ...(behavior ? { behavior } : {}),
    timingMs: Date.now() - started,
    prBody: join(root, '.uptide/pr-body.md'),
    notes: [
      ...pack.reviewNotes(packContext),
      ...(pending ? ['Tests/install left uncommitted files; review them before publication.'] : []),
    ],
  };
  // Review material is scoped to this run: only the rules its own sites have. The context it
  // is made from is kept, so a later build can render the same run with what it has learned.
  const rules = [...new Set(sites.map((s) => s.rule).filter((r): r is string => !!r))];
  result.packContext = packContext;
  refreshReview(result, pack);
  const decisions = pack.decisions?.(packContext, rules, followed);
  if (decisions?.length) result.decisions = decisions;
  const remote = originOf(root);
  if (remote) result.remote = remote;
  mkdirSync(dirname(result.prBody), { recursive: true });
  writeFileSync(result.prBody, prBody(result));
  const storedRun = join(root, '.uptide/report.json');
  writeFileSync(storedRun, JSON.stringify(result, null, 2));
  if (options.pr) {
    await publishVerified(result, { tool, ...(options.yes ? { yes: true } : {}) });
    writeFileSync(result.prBody, prBody(result));
    writeFileSync(storedRun, JSON.stringify(result, null, 2));
  }
  return result;
}

/**
 * The publish step of a `--pr` run, on a run that is already where it belongs. A refused
 * publication (unverified, dirty build) is recorded with its reasons; without `--yes` the
 * plan is printed and the run stands; a failing push or `gh` call is recorded as `failed`
 * and never thrown, because the verified run it belongs to must survive it.
 */
export async function publishVerified(
  result: FixReport,
  options: { tool: { uptideDirty: boolean }; yes?: boolean; cwd?: string },
  io?: Parameters<typeof import('./publish.js').publish>[2],
): Promise<void> {
  const blockers = publicationBlockers(result, options.tool);
  if (blockers.length) {
    // No --yes and no --no-llm changes this: the branch stays local and the report says why.
    result.publication = { refused: blockers };
    result.notes.push(`PR not opened: ${blockers.join('; ')}`);
    return;
  }
  const { publish } = await import('./publish.js');
  // The plan and any warning are kept on the run: the caller prints them when its progress
  // line is gone, instead of this step writing into the middle of a spinner.
  const log: string[] = [];
  const collect = (text: string): void => void log.push(text);
  try {
    result.prUrl = await publish(
      result,
      options.yes,
      io ? { ...io, print: collect } : { git, command, print: collect },
      options.cwd ? { cwd: options.cwd } : {},
    );
  } catch (error) {
    if (log.length) result.publicationLog = log.join('\n');
    const message = error instanceof Error ? error.message : String(error);
    if (!options.yes && /requires --yes/.test(message)) {
      // Without --yes the plan is the point: printed, and the run stands as verified.
      result.notes.push(
        `Publication plan printed, nothing pushed (no --yes): \`${UPTIDE_COMMAND} pr --branch ${result.branch} --yes\` opens the PR.`,
      );
      return;
    }
    result.publication = { refused: [], failed: message.split('\n')[0] ?? message };
    result.notes.push(
      `PR not opened: ${result.publication.failed}. The verified run is stored; \`${UPTIDE_COMMAND} pr --branch ${result.branch} --yes\` retries the publish step alone.`,
    );
    return;
  }
  if (log.length) result.publicationLog = log.join('\n');
}

/** Marks the evidence that sits where a selected finding has a compiler error. */
export function confirmedEvidence(
  evidence: NonNullable<PackContext['evidence']>,
  findings: Finding[],
): NonNullable<PackContext['evidence']> {
  const rejected = new Set(
    findings
      .filter((f) => f.usage.compileError !== undefined || f.usage.compileCode !== undefined)
      .map((f) => `${f.usage.file}:${f.usage.line}`),
  );
  return evidence.map((e) => (rejected.has(`${e.file}:${e.line}`) ? { ...e, compiler: true } : e));
}

/**
 * The pack's review material for a run, from the context the run stored: sections and the
 * changelog counts. A stored run is rendered with the current build's knowledge of what is
 * relevant, not with what the build that made it knew.
 */
export function refreshReview(
  result: FixReport,
  pack: MigrationPack | undefined = [zodPack, stripePack].find((p) => p.name === result.package),
): void {
  if (!pack || !result.packContext) return;
  const rules = [...new Set(result.sites.map((s) => s.rule).filter((r): r is string => !!r))];
  try {
    const sections = pack.reviewSections?.(result.packContext, rules);
    if (sections) result.reviewSections = sections;
    const apiChanges = pack.apiChanges?.(result.packContext);
    if (apiChanges) result.apiChanges = apiChanges;
  } catch {
    // What the run stored stands.
  }
}

export { selectedFindings } from './select.js';

export { safeFile } from './settle.js';
