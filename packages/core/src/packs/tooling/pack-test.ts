import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFsSurfaceCache } from '../../cache/fs-surface-cache.js';
import { check } from '../../check/check.js';
import type { CheckReport } from '../../domain/report.js';
import {
  type GroundTruth,
  type GroundTruthRepo,
  type Pack,
  type PackStatus,
  type PackVerification,
  publicRepos,
  type RegisteredPack,
  recordedStatus,
  statusOf,
  truthDigest,
} from '../contract.js';
import { type FixtureResult, fixturesPass, runFixtures } from './fixtures.js';
import { type EnsureOptions, ensureFixture, ensureRepo, label, truthProblems } from './truth.js';

/** A site as scored: repository-relative file, line, the rule it belongs to, its severity. */
export interface ScoredSite {
  file: string;
  line: number;
  rule: string;
  severity?: 'breaking' | 'deprecated' | 'unverified';
}

export interface Tally {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
}

export interface RepoScore {
  label: string;
  repo?: string;
  commit?: string;
  fixture?: string;
  from: string;
  to: string;
  /** Set when the repository could not be scored: nothing else below is meaningful. */
  error?: string;
  /** What the lockfile says is installed, when it is not the ground truth's `from`. */
  installedMismatch?: string;
  predicted: ScoredSite[];
  expected: ScoredSite[];
  /** Predicted sites no expected finding has, at the line level. */
  falsePositives: ScoredSite[];
  /** Expected findings nothing was predicted at. */
  falseNegatives: ScoredSite[];
  /** Real sites reported under another rule: `rule` is predicted, `expected` the truth's. */
  wrongRule: (ScoredSite & { expected: string })[];
}

export interface PackTestReport {
  package: string;
  dir: string;
  /** What the evidence below supports, and what `verification.json` says. */
  status: PackStatus;
  recorded: PackStatus;
  /** The recorded verification no longer matches this run (`--write` updates it). */
  stale: boolean;
  /** Ground truth was not scored (`--fixtures-only`). */
  fixturesOnly: boolean;
  verification: PackVerification;
  problems: string[];
  fixtures: FixtureResult;
  repos: RepoScore[];
  /** Ground truth, per rule: a site counts for a rule only when the rule matches too. */
  rules: Record<string, Tally>;
  /** Ground truth, at the line level, every severity. */
  overall: Tally;
  /** Ground truth, at the line level, breaking findings only: the verified gate. */
  breaking: Tally;
  passed: boolean;
}

/** The rule id a scored site is filed under: a rule or note of the pack, else `generic`. */
export const GENERIC_RULE = 'generic';

function ratio(a: number, b: number): number {
  return b === 0 ? 1 : a / b;
}

function tally(tp: number, fp: number, fn: number): Tally {
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
}

const key = (s: { file: string; line: number }): string => `${s.file}:${s.line}`;

/**
 * The sites `check` shows for the package, from its plan: the findings worth acting on,
 * grouped under the rule `fix` would apply. Repository-relative, as ground truth is written.
 */
export function predictedSites(report: CheckReport, pack: Pack): ScoredSite[] {
  const own = new Set([...pack.rules.map((r) => r.id), ...pack.behavior.map((b) => b.id)]);
  const sites = new Map<string, ScoredSite>();
  for (const p of report.packages) {
    const names = p.members ? p.members.map((m) => m.name) : [p.name];
    if (!names.includes(pack.name)) continue;
    const prefix = p.workspace === '.' || p.workspace === '*' ? '' : `${p.workspace}/`;
    for (const group of p.plan ?? [])
      for (const location of group.locations) {
        const file = location.file.startsWith(prefix) ? location.file : `${prefix}${location.file}`;
        const site: ScoredSite = {
          file,
          line: location.line,
          rule: own.has(group.rule) ? group.rule : GENERIC_RULE,
          severity: group.severity,
        };
        // One site, one rule: the more severe group wins, as the plan lists it first.
        if (!sites.has(key(site))) sites.set(key(site), site);
      }
  }
  return [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** One repository: what was predicted against what the ground truth expects. */
export function scoreSites(
  predicted: ScoredSite[],
  expected: ScoredSite[],
): Pick<RepoScore, 'falsePositives' | 'falseNegatives' | 'wrongRule'> {
  const truth = new Map(expected.map((e) => [key(e), e]));
  const seen = new Set(predicted.map(key));
  return {
    falsePositives: predicted.filter((p) => !truth.has(key(p))),
    falseNegatives: expected.filter((e) => !seen.has(key(e))),
    wrongRule: predicted
      .filter((p) => truth.has(key(p)) && truth.get(key(p))?.rule !== p.rule)
      .map((p) => ({ ...p, expected: truth.get(key(p))?.rule as string })),
  };
}

async function scoreRepo(
  pack: Pack,
  entry: GroundTruthRepo,
  root: string,
  options: EnsureOptions,
): Promise<RepoScore> {
  const expected = entry.findings.map((f) => ({ file: f.file, line: f.line, rule: f.rule }));
  const base: RepoScore = {
    label: label(entry),
    ...(entry.repo ? { repo: entry.repo } : {}),
    ...(entry.commit ? { commit: entry.commit } : {}),
    ...(entry.fixture ? { fixture: entry.fixture } : {}),
    from: entry.from,
    to: entry.to,
    predicted: [],
    expected,
    falsePositives: [],
    falseNegatives: [],
    wrongRule: [],
  };
  try {
    const dir = entry.fixture
      ? await ensureFixture(root, entry.fixture, options)
      : await ensureRepo(
          {
            repo: entry.repo as string,
            commit: entry.commit as string,
            ...(entry.directory ? { directory: entry.directory } : {}),
          },
          options,
        );
    const project = entry.directory ? join(dir, entry.directory) : dir;
    options.log?.(`checking ${pack.name} ${entry.from} → ${entry.to} in ${label(entry)}`);
    const report = await check({
      cwd: project,
      only: [pack.name],
      targets: { [pack.name]: entry.to },
      packs: [pack],
      // In this thread, with the pack under test: no worker loads the bundled registry.
      cache: createFsSurfaceCache(),
    });
    const installed = [
      ...new Set(report.packages.filter((p) => p.name === pack.name).map((p) => p.installed)),
    ];
    if (installed.length > 0 && !installed.includes(entry.from))
      base.installedMismatch = `the lockfile has ${installed.join(', ')}, the ground truth says ${entry.from}`;
    const predicted = predictedSites(report, pack);
    return { ...base, predicted, ...scoreSites(predicted, expected) };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

export interface PackTestOptions extends EnsureOptions {
  /** The uptide checkout: packs live in `<root>/packages/core/src/packs`. */
  root: string;
  /** Fixtures only: no repository is fetched or checked. */
  fixturesOnly?: boolean;
  /** Record this run's verification in the pack's `verification.json`. */
  write?: boolean;
  /** Write each fixture case's `after.ts` from what the rules produce. */
  updateFixtures?: boolean;
}

export function packsDir(root: string): string {
  return join(root, 'packages', 'core', 'src', 'packs');
}

export function readTruth(dir: string): { truth: GroundTruth; text: string } | undefined {
  const file = join(dir, 'ground-truth.json');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  return { truth: JSON.parse(text) as GroundTruth, text };
}

/** Fixtures and ground truth of one pack, scored; nothing is written. */
export async function testPack(
  entry: RegisteredPack,
  options: PackTestOptions,
): Promise<PackTestReport> {
  const { pack } = entry;
  const dir = join(packsDir(options.root), entry.dir);
  const problems: string[] = [];
  if (!pack.meta.sources.length) problems.push('meta.sources lists no changelog or guide');
  if (!pack.meta.maintainer) problems.push('meta.maintainer is empty');
  const fixtures = runFixtures(pack, dir, { update: options.updateFixtures === true });
  if (fixtures.cases.length === 0 && pack.rules.some((r) => r.rewrite || r.detect))
    problems.push('rules that rewrite or detect need fixtures (fixtures/<case>/before.ts)');
  const read = readTruth(dir);
  if (!read) problems.push('no ground-truth.json');
  const truth = read?.truth ?? { package: pack.name, repos: [] };
  problems.push(...truthProblems(truth, pack.name));

  const repos: RepoScore[] = [];
  if (!options.fixturesOnly && problems.length === 0)
    for (const repo of truth.repos) repos.push(await scoreRepo(pack, repo, options.root, options));

  const scored = repos.filter((r) => !r.error);
  const all = <K extends 'predicted' | 'expected' | 'falsePositives' | 'falseNegatives'>(k: K) =>
    scored.flatMap((r) => r[k]);
  const fp = all('falsePositives');
  const fn = all('falseNegatives');
  const predicted = all('predicted');
  const overall = tally(predicted.length - fp.length, fp.length, fn.length);
  const breakingPredicted = predicted.filter((p) => p.severity === 'breaking');
  const breakingFp = fp.filter((p) => p.severity === 'breaking');
  // A miss is a breaking one unless the rule it was expected under is deprecated.
  const deprecatedRules = new Set(
    pack.rules.filter((r) => r.severity === 'deprecated').map((r) => r.id),
  );
  const breaking = tally(
    breakingPredicted.length - breakingFp.length,
    breakingFp.length,
    fn.filter((f) => !deprecatedRules.has(f.rule)).length,
  );
  const rules: Record<string, Tally> = {};
  const ids = new Set([
    ...pack.rules.map((r) => r.id),
    ...pack.behavior.map((b) => b.id),
    ...predicted.map((p) => p.rule),
    ...all('expected').map((e) => e.rule),
  ]);
  for (const id of ids) {
    let tp = 0;
    let rfp = 0;
    let rfn = 0;
    for (const r of scored) {
      const want = new Set(r.expected.filter((e) => e.rule === id).map(key));
      const got = new Set(r.predicted.filter((p) => p.rule === id).map(key));
      for (const k of got) (want.has(k) ? () => tp++ : () => rfp++)();
      for (const k of want) if (!got.has(k)) rfn++;
    }
    if (tp + rfp + rfn > 0) rules[id] = tally(tp, rfp, rfn);
  }

  const status: PackStatus =
    repos.some((r) => r.error) || options.fixturesOnly
      ? 'candidate'
      : statusOf(truth, { falsePositives: breakingFp.length, predicted: breakingPredicted.length });
  const verification: PackVerification = {
    status,
    truth: read ? truthDigest(read.text) : '',
    repos: publicRepos(truth).length,
    breaking: {
      precision: Number(breaking.precision.toFixed(4)),
      recall: Number(breaking.recall.toFixed(4)),
      falsePositives: breakingFp.length,
    },
  };
  const recorded = recordedStatus(entry.verification);
  // Fixtures alone say nothing about ground truth: only a full run can find the record stale.
  let stale =
    !options.fixturesOnly && JSON.stringify(verification) !== JSON.stringify(entry.verification);
  const scoredAll = problems.length === 0 && repos.every((r) => !r.error);
  if (options.write && stale && scoredAll && !options.fixturesOnly) {
    writeVerification(options.root, entry.dir, verification);
    stale = false;
  }
  const passed = scoredAll && fixturesPass(fixtures) && breakingFp.length === 0 && !stale;
  return {
    package: pack.name,
    dir: entry.dir,
    status,
    recorded,
    stale,
    fixturesOnly: options.fixturesOnly === true,
    verification,
    problems,
    fixtures,
    repos,
    rules,
    overall,
    breaking,
    passed,
  };
}

/** `--write`: the record the runtime gate reads, as this run measured it. */
export function writeVerification(root: string, dir: string, record: PackVerification): string {
  const file = join(packsDir(root), dir, 'verification.json');
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}
