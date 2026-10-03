import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTypescriptAdapter } from '../adapters/typescript/index.js';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { importedByText } from '../check/importers.js';
import { readManifest } from '../check/module-format.js';
import { compareVersions } from '../check/version.js';
import { progress } from '../domain/progress.js';
import type { Finding } from '../domain/report.js';
import { UptideError } from '../errors.js';
import { sdkApiVersion, stripePack } from '../packs/stripe/index.js';
import { pinClient, unpinnedClients } from '../packs/stripe/relevance.js';
import { uptideVersionInfo } from '../version.js';
import { generateClients } from './generate.js';
import { git } from './process.js';
import { editDiff, prBody } from './report.js';
import type { FixOptions, FixServices } from './run.js';
import { commit, safeFile, settle } from './settle.js';
import { lintFiles } from './style.js';
import type { FixReport, FixSite } from './types.js';
import { markPreexisting, newDiagnostics } from './verify.js';

export const PIN_RULE = 'api-version-pin';

/**
 * `fix --only stripe --pin-current-api`: the small PR. The SDK stays where it is; every client
 * created without `apiVersion` gets the version that SDK defaults to, written down. Zero
 * behaviour change today, and the next SDK bump no longer moves the API version silently.
 * Same guard rails as a migration: clean tree, baseline, branch, verification, PR body.
 */
export async function pinCurrentApi(
  options: FixOptions,
  services: FixServices,
  originOf: (root: string) => string | undefined,
): Promise<FixReport> {
  const started = Date.now();
  const root = realpathSync(resolve(options.cwd));
  if (options.only !== 'stripe')
    throw new UptideError('ANALYSIS_FAILED', '--pin-current-api applies to stripe only');
  const tool = options.tool ?? uptideVersionInfo();
  const adapter = createTypescriptAdapter();
  const all = workspacePackagesOf(root);
  // Declared or not: a workspace that creates a client is a workspace to pin.
  const workspaces = all.filter(
    (w) =>
      installedVersion(root, w) !== undefined ||
      importedByText(root, w, ['stripe'], all).length > 0,
  );
  const versions = workspaces
    .map((w) => installedVersion(root, w))
    .filter((v): v is string => v !== undefined)
    .sort(compareVersions);
  const installed = versions[0];
  if (!installed) throw new UptideError('PACKAGE_NOT_INSTALLED', 'stripe is not installed');
  const sdkDir = workspaces
    .map((w) => adapter.installedPackageDir({ dir: join(root, w) }, 'stripe'))
    .find((d) => d !== undefined);
  if (!sdkDir) throw new UptideError('PACKAGE_NOT_INSTALLED', 'stripe is not installed');
  const apiVersion = sdkApiVersion(sdkDir);
  const branch = `uptide/stripe-pin-${apiVersion}`;
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  // The clients, from the same usage scan `check` runs: every `new Stripe(...)` the checker sees.
  const findings: Finding[] = [];
  for (const workspace of workspaces) {
    const repo = { dir: join(root, workspace) };
    const surface = await progress(options.onProgress, { phase: 'usages', workspace }, () =>
      adapter.installedSurface(repo, 'stripe', installed),
    );
    if (!surface) continue;
    const scan = await adapter.findUsages(repo, 'stripe', surface);
    const sites = unpinnedClients(scan.usages, (file) => read(join(workspace, file)));
    for (const site of sites) {
      // A workspace's program reaches sibling sources through `workspace:` links; the client
      // in packages/core is core's to pin, once.
      if (site.file.startsWith('..')) continue;
      const file = join(workspace, site.file);
      if (findings.some((f) => f.usage.file === file && f.usage.line === site.line)) continue;
      const path = 'Stripe.StripeConfig#apiVersion';
      findings.push({
        change: {
          package: 'stripe',
          from: installed,
          to: installed,
          path,
          kind: 'type',
          severity: 'breaking',
          source: 'pack',
          confidence: 1,
          before: apiVersion,
          after: apiVersion,
        },
        usage: { ...site, file, symbolPath: path, access: 'construct', via: 'direct' },
        severity: 'breaking',
        confidence: 1,
        fixability: 'mechanical',
        reason: `created without apiVersion: speaks ${apiVersion}, the SDK default, without saying so`,
        rule: PIN_RULE,
      });
    }
  }
  if (findings.length === 0)
    throw new UptideError(
      'ANALYSIS_FAILED',
      'every Stripe client already sets apiVersion; nothing to pin',
    );
  const affected = [...new Set(findings.map((f) => f.usage.file))];
  const verify = <T>(detail: string, work: () => T | Promise<T>): Promise<T> =>
    progress(options.onProgress, { phase: 'verify', package: 'stripe', detail }, work);
  const names = (list: string[]): string =>
    list.map((w) => (w === '.' ? 'root' : (w.split('/').pop() ?? w))).join(', ');
  const generated = await verify('generate', () =>
    (services.generate ?? generateClients)(root, workspaces),
  );
  const baseline = await verify(`types (${names(workspaces)})`, () =>
    services.diagnostics(root, workspaces),
  );
  // Tests run where something changes: the workspace each edited file belongs to (the
  // deepest one), not every workspace that imports stripe.
  const ownerOf = (file: string): string | undefined =>
    workspaces
      .filter((w) => w === '.' || file.startsWith(`${w}/`))
      .sort((a, b) => b.length - a.length)[0];
  const edited = workspaces.filter((w) => affected.some((f) => ownerOf(f) === w));
  const baselineTests = await verify(`tests (${names(edited)})`, () =>
    services.tests(root, edited, options.testTimeoutMs, affected, {
      withServices: options.withServices === true,
    }),
  );
  if (git(root, 'status', '--porcelain', '--untracked-files=all'))
    throw new Error('baseline tests modified the working tree; review their changes before fixing');
  const baselineLint = await (services.lint ?? lintFiles)(root, affected);
  git(root, 'switch', '-c', branch);
  const sites: FixSite[] = [];
  const changed = new Set<string>();
  // Several clients in one file: edit from the last line up, so earlier lines keep their numbers.
  for (const finding of [...findings].sort(
    (a, b) => a.usage.file.localeCompare(b.usage.file) || b.usage.line - a.usage.line,
  )) {
    const file = safeFile(root, finding.usage.file);
    const original = readFileSync(file, 'utf8');
    const pinned = pinClient(original, finding.usage.line, apiVersion);
    if (pinned === undefined) {
      sites.push({
        finding,
        outcome: 'manual',
        reason: 'the client options are built elsewhere; add apiVersion there',
        rule: PIN_RULE,
      });
      continue;
    }
    writeFileSync(file, pinned);
    changed.add(file);
    sites.push({
      finding,
      outcome: 'mechanical',
      reason: `apiVersion: '${apiVersion}' added, the version this SDK already defaults to`,
      diff: editDiff(original, pinned),
      rule: PIN_RULE,
    });
  }
  commit(root, `fix(stripe): pin the API version to ${apiVersion}`, [...changed]);
  const {
    tests: ran,
    after,
    lint,
    formatted,
  } = await settle({
    root,
    pack: stripePack,
    context: { from: installed, to: installed, includeDeprecated: false },
    workspaces,
    testWorkspaces: edited,
    sites,
    followed: [],
    affected,
    from: installed,
    target: installed,
    baselineLint,
    services,
    withServices: options.withServices === true,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const tests = markPreexisting(ran, baselineTests);
  const pending = git(root, 'status', '--porcelain', '--untracked-files=all');
  const newErrors = newDiagnostics(baseline, after);
  const result: FixReport = {
    repo: root,
    package: 'stripe',
    from: installed,
    target: installed,
    mode: 'pin',
    apiVersion,
    ...(generated.length ? { generated } : {}),
    ...tool,
    verifiedAt: new Date().toISOString(),
    head: git(root, 'rev-parse', 'HEAD'),
    branch,
    sites,
    verification: {
      baseline,
      target: baseline,
      after,
      newErrors,
      baselineTests,
      tests,
      ...(lint.length ? { lint } : {}),
      ...(formatted.length ? { formatted } : {}),
      passed:
        newErrors.length === 0 &&
        !pending &&
        tests.every((t) => t.status === 'passed' || t.status === 'missing' || t.preexisting) &&
        lint.every((l) => l.status !== 'failed'),
    },
    llm: { inputTokens: 0, outputTokens: 0, costUsd: 0, available: false, disabled: true },
    timingMs: Date.now() - started,
    prBody: join(root, '.uptide/pr-body.md'),
    notes: [
      `stripe stays at ${installed}; its default API version is ${apiVersion}, now explicit on every client.`,
      ...(pending ? ['Tests/install left uncommitted files; review them before publication.'] : []),
    ],
  };
  const remote = originOf(root);
  if (remote) result.remote = remote;
  mkdirSync(dirname(result.prBody), { recursive: true });
  writeFileSync(result.prBody, prBody(result));
  writeFileSync(join(root, '.uptide/report.json'), JSON.stringify(result, null, 2));
  return result;
}

function installedVersion(root: string, workspace: string): string | undefined {
  const manifest = readManifest(join(root, workspace));
  const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .map(
      (s) =>
        (manifest as Record<string, Record<string, string> | undefined> | undefined)?.[s]?.stripe,
    )
    .find((v) => typeof v === 'string');
  if (!declared) return undefined;
  const dir = createTypescriptAdapter().installedPackageDir(
    { dir: join(root, workspace) },
    'stripe',
  );
  return dir ? readManifest(dir)?.version : undefined;
}
