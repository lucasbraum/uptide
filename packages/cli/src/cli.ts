import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CheckReport, CheckResult, FixReport } from '@uptide/core';
import {
  formatFix,
  isFailure,
  PRICE_DATE,
  priceFor,
  selectLlm,
  TIER_LEGEND,
  uptideCommand,
} from '@uptide/core';
import { Command, CommanderError } from 'commander';
import { describeRepo, detectRepo, type Repo } from './detect.js';
import { defaultEngine, type Engine } from './engine.js';
import { CliError, EXIT, renderError } from './errors.js';
import {
  assistedNote,
  isNetworkError,
  networkFailure,
  noAgentForGeneric,
  noApiKeyNote,
  noNetwork,
  notADependency,
  requireFixable,
  requireInstalled,
  requireNodeModules,
} from './failures.js';
import { formatHuman } from './format.js';
import { type CheckHeader, formatCheck, repoLine } from './format-check.js';
import { formatFixSummary } from './format-fix.js';
import { formatList } from './format-list.js';
import { formatPlan } from './format-plan.js';
import { writeMigrationHtml } from './html/migration.js';
import { writePlanHtml } from './html/plan.js';
import { openHtml, writeHtml } from './html/write.js';
import { type Io, type Ui, type UiFlags, uiOf } from './io.js';
import { PRIVACY } from './privacy.js';
import { createProgress, elapsed, type Progress } from './progress.js';
import {
  collectStatus,
  declaredDependencies,
  formatStatus,
  locateDependencies,
  SUPPORTED as PACKED,
} from './status.js';
import { createTelemetry, type Telemetry } from './telemetry/client.js';
import { checkMetrics, fixMetrics, listMetrics } from './telemetry/metrics.js';

/** Replaced by the bundler with this package's version; tests and tsx run the source. */
declare const __UPTIDE_VERSION__: string | undefined;
export const VERSION =
  typeof __UPTIDE_VERSION__ === 'string'
    ? __UPTIDE_VERSION__
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        .version as string);

const EXIT_CODES = (zero: string, one: string, two = ''): string => `
Exit codes:
  0  ${zero}
  1  ${one}
  2  uptide could not answer: bad arguments, unsupported repository, no network${two}
`;

interface Shared extends UiFlags {
  cwd?: string;
  json?: boolean;
}

/** The flags every command takes, in the same words. */
function shared(command: Command): Command {
  return command
    .option('--cwd <dir>', 'repository to work on (default: current directory)')
    .option('--json', 'machine-readable result on stdout; progress stays on stderr')
    .option('--ci', 'plain output for logs: no color, no spinner')
    .option('--no-color', 'no color (NO_COLOR is respected too)');
}

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** `zod@4.6.5`, `latest`, or a bare version when a single package is selected. */
export function parseTargets(
  specs: string[] | undefined,
  only: string[] | undefined,
): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const spec of specs ?? []) {
    if (spec === 'latest') continue;
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      const name = spec.slice(0, at);
      // A target for a package that is not being checked would silently do nothing.
      if (only && !only.includes(name))
        throw new CliError(
          `--target ${spec}: ${name} is not among the packages selected (${only.join(', ')})`,
          { next: `uptide check ${name} --target ${spec}` },
        );
      targets[name] = spec.slice(at + 1);
    } else if (only?.length === 1 && only[0] && /^\d/.test(spec)) targets[only[0]] = spec;
    else
      throw new CliError(`--target ${spec}: expected <package>@<version> or latest`, {
        next: 'uptide check zod --target zod@4.6.5',
      });
  }
  return targets;
}

/** A prerelease build tells people to run the prerelease: `latest` may not have this command yet. */
// npm latest is a placeholder until the stable CLI launch.
/** `npx uptide`, or `npx uptide@next` when this build is a prerelease: commands must reach this build. */
const INVOCATION = uptideCommand(VERSION);
const HTML_INVOCATION = INVOCATION;
/** Package managers `fix` can upgrade and verify with. */
const FIX_MANAGERS: readonly string[] = ['pnpm', 'npm', 'yarn'];

function headerOf(repo: Repo, ms: number): CheckHeader {
  return {
    repo: repo.name ?? basename(repo.root),
    manager: repo.manager,
    packages: repo.workspaces.filter((w) => w !== '.').length,
    ms,
  };
}

/** After a run in a private clone: whether it is still there, and that the checkout was left alone. */
function whereItRan(report: FixReport): string {
  if (!report.source) return '';
  const untouched = report.sourceChanged?.length
    ? `Warning: your checkout changed during the run: ${report.sourceChanged.join('; ')}.`
    : 'Your checkout was not touched: same branch, files, hooks and git config.';
  const clone = report.clone?.kept
    ? `Temporary clone kept: ${report.clone.path}\n  ${report.clone.reason}; \`uptide clean\` removes kept clones older than 7 days.`
    : 'Ran in a temporary clone, removed now that the run is over.';
  return `${clone}\n${untouched}\n`;
}

/** One line per analyzed dependency: where the analysis time went. */
function timingNotes(report: CheckResult, progress: Progress): void {
  for (const p of report.packages) {
    const t = p.timing;
    const parts = [
      ['fetch', t.fetchMs],
      ['diff', t.diffMs],
      ['usages', t.usagesMs],
      ['compile', t.compileMs],
      ['runtime', t.runtimeMs ?? 0],
    ]
      .filter(([, ms]) => (ms as number) >= 1)
      .map(([name, ms]) => `${name} ${elapsed(ms as number)}`);
    if (parts.length === 0) continue;
    const where = p.workspace === '.' || p.workspace === '*' ? '' : ` (${p.workspace})`;
    progress.note(`${p.name} ${p.installed} → ${p.target}${where}: ${parts.join(', ')}`);
  }
}

/**
 * Run the CLI with `argv` (without `node` and the script path) and return the exit code.
 * Nothing here touches `process`: output goes through `io`, analysis through `engine`.
 */
export async function run(
  argv: string[],
  io: Io,
  engine: Engine = defaultEngine(),
  telemetry?: Telemetry,
): Promise<number> {
  let code: number = EXIT.ok;
  let fixing = false,
    fixEngineStarted = false;
  let fixSpend: FixReport['llm'] | undefined;

  /** Shared shape of every action: UI from the flags, failures rendered once, exit code kept. */
  const act = async (
    flags: Shared,
    body: (ctx: { ui: Ui; progress: Progress; cwd: string }) => Promise<number>,
    options: { quiet?: boolean } = {},
  ): Promise<void> => {
    const ui = uiOf(io, flags);
    try {
      code = await body({
        ui,
        progress: createProgress(io, ui, options),
        cwd: resolve(io.cwd, flags.cwd ?? '.'),
      });
    } catch (err) {
      io.err(renderError(err, ui.color));
      code = err instanceof CliError ? (err.options.exitCode ?? EXIT.error) : EXIT.error;
    }
  };
  const emit = (value: unknown): void => io.out(`${JSON.stringify(value, null, 2)}\n`);

  /** Before any analysis: what was asked for exists and the repository is installed. */
  const requireDependencies = (
    repo: Repo,
    only: string[] | undefined,
    progress: Progress,
  ): Promise<unknown> =>
    progress.phase(
      'Dependencies',
      async () => {
        const deps = await locateDependencies(
          repo,
          engine,
          only ?? (await declaredDependencies(repo, engine)),
        );
        if (only) {
          // Asked for by name and absent is an error, not an empty answer.
          const absent = deps.filter((d) => d.workspaces.length === 0).map((d) => d.name);
          if (absent.length > 0) throw notADependency(repo, absent);
          requireInstalled(repo, deps);
        } else requireNodeModules(repo, deps);
        return deps;
      },
      (deps) =>
        only ? deps.map((d) => `${d.name} ${d.installed}`).join(', ') : `${deps.length} declared`,
    );

  const program = new Command()
    .name('uptide')
    .description(
      'Migrations you can merge.\n\nWith no command: where zod and stripe stand in this repository.',
    )
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text), writeErr: (text) => io.err(text) })
    .showHelpAfterError('(run with --help for usage)')
    .enablePositionalOptions()
    .allowExcessArguments(true);

  program.hook('preAction', async (_parent, command) => {
    fixing = command.name() === 'fix';
    await telemetry?.begin(command.name(), command.optsWithGlobals()).catch(() => {});
  });
  shared(
    program
      .command('telemetry')
      .description('Control opt-in anonymous telemetry')
      .argument('<action>', 'on, off, status or show'),
  ).action((action: string, flags: Shared) =>
    act(flags, async () => {
      if (!['on', 'off', 'status', 'show'].includes(action))
        throw new CliError('Expected telemetry on, off, status or show.');
      const value = (telemetry ?? createTelemetry(io, { version: VERSION })).control(
        action,
        flags.ci,
      );
      if (flags.json || action === 'show') emit(value);
      else io.out(`Telemetry: ${JSON.stringify(value, null, 2)}\n`);
      return EXIT.ok;
    }),
  );

  shared(program)
    .addHelpText(
      'after',
      `
Examples:
  $ npx uptide                     where zod and stripe stand in this repository
  $ npx uptide list                discover outdated dependencies quickly
  $ npx uptide check zod           which of your call sites the upgrade breaks
  $ npx uptide fix zod      migrate on a new branch, verified by your compiler and tests
${EXIT_CODES('nothing breaking', 'breaking changes found, or a migration that did not verify')}
${PRIVACY}`,
    )
    .action((flags: Shared) =>
      act(flags, async ({ ui, progress, cwd }) => {
        const unknown = program.args[0];
        if (unknown) throw new CliError(`unknown command '${unknown}'`, { next: 'uptide --help' });
        const repo = await progress.phase(
          'Repository',
          () => detectRepo(cwd, engine.workspaces),
          describeRepo,
        );
        const status = await progress.phase(
          'Versions',
          () => collectStatus(repo, engine),
          (s) => (s.registryError ? 'registry unreachable' : 'lockfile and registry read'),
        );
        telemetry?.record(() => ({
          repo: repo.root,
          packages: status.dependencies.map((d) => ({
            name: d.name,
            versions: [d.installed, d.latest].filter((v): v is string => !!v),
          })),
          counts: { packages: status.dependencies.length, workspaces: status.workspaces.length },
        }));
        if (flags.json) emit(status);
        else io.out(`\n${formatStatus(status, { color: ui.color })}`);
        return EXIT.ok;
      }),
    );

  shared(
    program
      .command('list')
      .description('Discover outdated dependencies without compiling or installing')
      .option('--all', 'expand minor and patch upgrades'),
  )
    .addHelpText(
      'after',
      `\nExamples:\n  $ uptide list\n  $ uptide list --all --json\n\nNo compilation, install or tarball downloads; registry metadata only.\nUsage counts direct calls/new/JSX through imported bindings. Unused tools may still\nbe needed by scripts/configuration. Majors first, then importing files and call sites.\n${EXIT_CODES('discovery complete', 'not used', '; incomplete discovery retains successful rows')}`,
    )
    .action((flags: Shared & { all?: boolean }) =>
      act(flags, async ({ cwd, progress }) => {
        const started = io.now();
        const repo = await detectRepo(cwd, engine.workspaces);
        if (!engine.list) throw new CliError('this build cannot list dependencies');
        const discover = engine.list;
        const report = await progress.phase('Discovery', () => discover({ cwd: repo.root }));
        telemetry?.record(() => listMetrics(report));
        if (flags.json) emit(report);
        else
          io.out(
            formatList(report, {
              all: flags.all,
              header: headerOf(repo, io.now() - started),
              invocation: INVOCATION,
              cwd: flags.cwd,
            }),
          );
        return report.failures.length ? EXIT.error : EXIT.ok;
      }),
    );

  shared(
    program
      .command('check [packages...]')
      .description('Which of your call sites an upgrade breaks, and what fixing them costs')
      .option('--only <packages>', 'deprecated alias for positional package names')
      .option(
        '--target <spec...>',
        '`<package>@<version>`, repeatable; a bare version with one named package (default: latest)',
      )
      .option('--html [path]', 'write a self-contained HTML report (default: OS temp directory)')
      .option('--open', 'open the HTML report in your browser (interactive terminals only)')
      .option('--details', 'every site with its reason, compiler message and analysis notes')
      .option('--all', 'with --details: also show findings under 50% confidence')
      .option('--verbose', 'one progress line per analysis phase, with timings')
      .option('--no-compile', 'skip compiling against the target version')
      .option('--no-runtime', 'skip loading installed and target copies in a sandboxed Node')
      .option('--all-deps', 'also analyze @types/* and dependencies the repo never imports')
      .option(
        '--workspaces <n>',
        'maximum concurrent workspaces (also capped by free memory and CPU)',
      )
      .option('--no-remote', 'accepted for forward compatibility; there is no remote service'),
  )
    .addHelpText(
      'after',
      `
What it checks:
  Only the named dependencies. Run uptide list first for fast discovery.
  No names: exits 2 without analysis. Failures are reported per package/workspace.

Tiers:
  ${TIER_LEGEND}

Examples:
  $ uptide list                           discover upgrades without compiling
  $ uptide check zod stripe               analyze the named packages
  $ uptide check zod --target 4.6.5
  $ uptide check zod --details                every site and reason
  $ uptide check zod --json --ci > uptide.json
${EXIT_CODES(
  'no breaking change reaches your code, in everything that was analyzed',
  'breaking changes found at your call sites',
  ';\n     or nothing breaking was found but a dependency failed to analyze (the report\n     still lists the others). A skipped workspace is not a safety verdict.',
)}`,
    )
    .action(
      (
        packages: string[],
        flags: Shared & {
          only?: string;
          target?: string[];
          html?: string | true;
          open?: boolean;
          details?: boolean;
          all?: boolean;
          verbose?: boolean;
          compile?: boolean;
          runtime?: boolean;
          allDeps?: boolean;
          workspaces?: string;
        },
      ) =>
        act(
          flags,
          async ({ ui, progress, cwd }) => {
            if (flags.open && !flags.html) throw new CliError('--open requires --html');
            const started = io.now();
            const quiet = !flags.verbose;
            const only = [...new Set([...packages, ...(list(flags.only) ?? [])])];
            if (only.length === 0 || only.includes('all'))
              throw new CliError(
                'check requires one or more package names. Start with uptide list.',
                { next: 'uptide list' },
              );
            const targets = parseTargets(flags.target, only);
            if (
              flags.workspaces &&
              (!Number.isInteger(Number(flags.workspaces)) || Number(flags.workspaces) < 1)
            )
              throw new CliError('--workspaces must be a positive integer');
            const repo = await progress.phase(
              'Repository',
              () => detectRepo(cwd, engine.workspaces),
              describeRepo,
            );
            const htmlReport = async (report: CheckReport): Promise<void> => {
              if (flags.html) {
                const path = writeHtml(
                  report,
                  {
                    root: repo.root,
                    version: VERSION,
                    date: new Date().toISOString(),
                    header: headerOf(repo, io.now() - started),
                    invocation: HTML_INVOCATION,
                    repeat: {
                      cwd: resolve(io.cwd) === resolve(repo.root) ? undefined : repo.root,
                      only: only.join(','),
                      targets: {
                        ...Object.fromEntries(
                          report.packages
                            .flatMap((p) => p.members ?? [p])
                            .filter((p) => p.target && p.installed !== p.target)
                            .map((p) => [p.name, p.target]),
                        ),
                        ...targets,
                      },
                    },
                    fixable: FIX_MANAGERS.includes(repo.manager),
                  },
                  flags.html,
                  io.cwd,
                );
                io.err(`HTML report: ${path}\n`);
                if (flags.open && ui.interactive && io.outTty) {
                  try {
                    await openHtml(path);
                  } catch (error) {
                    io.err(
                      `Could not open browser: ${error instanceof Error ? error.message : String(error)}. Open the report manually.\n`,
                    );
                  }
                }
              }
            };
            // Without a terminal there is no live line: say what started, then how long it took.
            if (quiet && !ui.interactive) io.err(`uptide check · ${repoLine(headerOf(repo, 0))}\n`);
            await requireDependencies(repo, only, progress);
            const report = await progress.phase(
              only
                ? `Analysis of ${only.join(', ')}`
                : 'Analysis of every dependency that is behind',
              async () => {
                // A registry that cannot be reached is a failed phase, not an empty report.
                const result = await engine
                  .check(
                    {
                      cwd: repo.root,
                      targets,
                      only,
                      compile: flags.compile ?? true,
                      runtime: flags.runtime ?? true,
                      allDeps: flags.allDeps,
                      ...(flags.workspaces
                        ? { workspaceConcurrency: Number(flags.workspaces) }
                        : {}),
                    },
                    progress.event,
                  )
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    throw isNetworkError(err) ? noNetwork(message) : err;
                  });
                const offline = networkFailure(result);
                if (offline) throw offline;
                return result;
              },
              (r) => `${r.summary.breaking} breaking, ${r.summary.deprecated} deprecated`,
            );
            telemetry?.record(() => checkMetrics(report));
            timingNotes(report, progress);
            const ms = io.now() - started;
            if (quiet && !ui.interactive) io.err(`done in ${elapsed(ms)}\n`);
            if (flags.json) emit(report);
            else
              io.out(
                formatCheck(report, {
                  color: ui.color,
                  details: flags.details,
                  all: flags.all,
                  header: headerOf(repo, ms),
                  invocation: INVOCATION,
                  repeat: {
                    ...(flags.cwd ? { cwd: flags.cwd } : {}),
                    only: only.join(','),
                    targets,
                  },
                  fixable: FIX_MANAGERS.includes(repo.manager),
                }),
              );
            await htmlReport(report);
            // Breaking is an answer whatever else happened. Without it, a dependency that
            // failed to analyze means the question was not fully answered: the report above
            // lists the others and says which failed, and the code says "incomplete".
            if (report.summary.breaking > 0) return EXIT.breaking;
            return report.packages.some((p) => isFailure(p)) ? EXIT.error : EXIT.ok;
          },
          { quiet: !flags.verbose },
        ),
    );

  shared(
    program
      .command('plan')
      .option('--results <file>', 'JSON from an earlier check; matching package versions only')
      .description('The order to upgrade your dependencies in, with the effort each one takes')
      .option(
        '--only <packages>',
        'comma-separated dependencies to plan (default: every direct dependency that is behind)',
      )
      .option('--html [path]', 'write the plan as a self-contained HTML page')
      .option('--verbose', 'one progress line per analysis phase, with timings'),
  )
    .addHelpText(
      'after',
      `
What it does:
  Uses list data and optional --results <check.json>. No implicit deep analysis.
  Unchecked packages have unknown effort; run check before fixing them. Peer ranges between your dependencies
  decide what has to come first or move together; a range nothing satisfies is named as
  blocked. Effort is an estimate from the findings, not a promise.

Examples:
  $ uptide plan
  $ uptide plan --only react,react-dom,next
  $ uptide plan --json --ci > plan.json
${EXIT_CODES('a plan was made', 'not used', ';\n     or a dependency failed to analyze (the plan still orders the others)')}`,
    )
    .action(
      (
        flags: Shared & {
          only?: string;
          results?: string;
          html?: string | true;
          verbose?: boolean;
        },
      ) =>
        act(
          flags,
          async ({ ui, progress, cwd }) => {
            const started = io.now();
            const only = list(flags.only);
            const checkResults = flags.results
              ? (JSON.parse(readFileSync(resolve(io.cwd, flags.results), 'utf8')) as CheckReport)
              : undefined;
            const repo = await progress.phase(
              'Repository',
              () => detectRepo(cwd, engine.workspaces),
              describeRepo,
            );
            if (!flags.verbose && !ui.interactive)
              io.err(`uptide plan · ${repoLine(headerOf(repo, 0))}\n`);
            if (!engine.plan) throw new CliError('this build cannot plan upgrades');
            const plan = engine.plan;
            const result = await progress.phase(
              only ? `Plan for ${only.join(', ')}` : 'Plan for every dependency that is behind',
              async () => {
                const planned = await plan(
                  {
                    cwd: repo.root,
                    only,
                    checkResults,
                  },
                  progress.event,
                ).catch((err: unknown) => {
                  const message = err instanceof Error ? err.message : String(err);
                  throw isNetworkError(err) ? noNetwork(message) : err;
                });
                const offline = networkFailure(planned.report);
                if (offline) throw offline;
                return planned;
              },
              (r) => `${r.plan.steps.length} steps`,
            );
            const ms = io.now() - started;
            if (!flags.verbose && !ui.interactive) io.err(`done in ${elapsed(ms)}\n`);
            telemetry?.record(() => {
              const metrics = checkMetrics(result.report);
              return { ...metrics, counts: { ...metrics.counts, steps: result.plan.steps.length } };
            });
            const fixable = FIX_MANAGERS.includes(repo.manager);
            const planOptions = {
              header: headerOf(repo, ms),
              invocation: INVOCATION,
              fixable,
              ...(flags.cwd ? { cwd: flags.cwd } : {}),
            };
            if (flags.json) emit(result.plan);
            else io.out(formatPlan(result.plan, { color: ui.color, ...planOptions }));
            if (flags.html) {
              const path = writePlanHtml(
                result.plan,
                { ...planOptions, version: VERSION, date: new Date(io.now()).toISOString() },
                flags.html,
                io.cwd,
              );
              io.err(`HTML plan: ${path}\n`);
            }
            return result.report.packages.some((p) => isFailure(p)) ? EXIT.error : EXIT.ok;
          },
          { quiet: !flags.verbose },
        ),
    );

  shared(
    program
      .command('fix [package]')
      .allowExcessArguments(false)
      .description('Upgrade one dependency on a new branch and migrate your code, verified')
      .option(
        '--only <package>',
        'the dependency to upgrade: zod or stripe (verified), or any other (generic, agent only)',
      )
      .option(
        '--target <spec>',
        'exact version, optionally `<package>@<version>` (default: latest on npm, as check uses)',
      )
      .option('--include-deprecated', 'migrate reported deprecated sites too')
      .option(
        '--pin-current-api',
        "stripe only: no upgrade; write the installed SDK's default apiVersion on every client that omits it",
      )
      .option(
        '--provider <name>',
        'LLM provider: anthropic, openai or gemini (also UPTIDE_PROVIDER)',
      )
      .option('--model <id>', 'LLM model ID (also UPTIDE_MODEL)')
      .option('--no-llm', 'rule-based fixes only: never send code to the LLM provider')
      .option(
        '--max-cost <usd>',
        'reserve the worst-case cost before each LLM call, including retries (default: 1 USD for every package)',
      )
      .option(
        '--with-services',
        'also run tests that need a database, cache or queue; prints the targets, requires --yes',
      )
      .option(
        '--keep',
        'keep the temporary clone after the run (it is kept anyway when the run fails)',
      )
      .option('--pr', 'open a draft PR after verification passes; requires --yes')
      .option(
        '--yes',
        'approve what was printed: the publication plan (--pr), the services (--with-services)',
      )
      .option('--verbose', 'one progress line per phase, with timings'),
  )
    .addHelpText(
      'after',
      `
What it does:
  Works in a temporary clone of your repository, never in your checkout: your branch, files,
  git hooks and git config stay as they are. Install, build and test commands run with
  lifecycle scripts and git hooks disabled.
  Runs check, creates branch uptide/<package>-<version>, bumps the version and lockfile,
  applies rule-based fixes, then (with the selected provider's API key, unless --no-llm) assisted fixes
  for the remaining sites, and verifies with your TypeScript and your test scripts.
  Nothing is pushed without --pr --yes.

Tiers:
  ${TIER_LEGEND}
  A generic package has no rules: every fix comes from the agent, under the same checks (an
  edit is kept only if the site's compiler error disappears and no new one appears) and the
  same publish gate. It needs ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY; --max-cost defaults to $1.

Examples:
  $ uptide fix zod
  $ uptide fix express --max-cost 2    a generic package, with a budget for the agent
  $ uptide fix stripe --target 22.6.2
  $ uptide fix stripe --pin-current-api   the small PR: same SDK, apiVersion made explicit
  $ uptide fix zod --no-llm        no code leaves this machine
${EXIT_CODES('migration verified: no new type errors, tests pass', 'verification failed or sites remain for manual work')}
${PRIVACY}`,
    )
    .action(
      (
        packageName: string | undefined,
        flags: Shared & {
          only?: string;
          target?: string;
          includeDeprecated?: boolean;
          pinCurrentApi?: boolean;
          llm?: boolean;
          maxCost?: string;
          provider?: string;
          model?: string;
          withServices?: boolean;
          keep?: boolean;
          pr?: boolean;
          yes?: boolean;
          verbose?: boolean;
        },
      ) =>
        act(
          flags,
          async ({ ui, progress, cwd }) => {
            const started = io.now();
            const quiet = !flags.verbose;
            if (packageName && flags.only && packageName !== flags.only)
              throw new CliError('choose one package for fix');
            const only = packageName ?? flags.only;
            if (!only)
              throw new CliError('fix requires a package name. Start with uptide list.', {
                next: 'uptide list',
              });
            if (only.includes(','))
              throw new CliError(`--only ${only}: fix upgrades one dependency at a time`, {
                next: `uptide fix ${only.split(',')[0]}`,
              });
            const maxCost = flags.maxCost !== undefined ? Number(flags.maxCost) : 1;
            const selection = selectLlm(cwd, flags, io.env);
            if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0))
              throw new CliError(`--max-cost ${flags.maxCost}: expected an amount in USD`, {
                next: `uptide fix ${only} --max-cost 2`,
              });
            // No pack, so no rule: without the agent there is nothing this command can do,
            // and it says so before it touches anything.
            const hasPack = (PACKED as readonly string[]).includes(only);
            if (!hasPack && (flags.llm === false || !selection.available))
              throw noAgentForGeneric(only, flags.llm === false);
            if (flags.pinCurrentApi && only !== 'stripe')
              throw new CliError('--pin-current-api applies to stripe only', {
                next: 'uptide fix stripe --pin-current-api',
              });
            if (flags.pinCurrentApi && flags.target)
              throw new CliError('--pin-current-api keeps the installed version; drop --target', {
                next: 'uptide fix stripe --pin-current-api',
              });
            // `--only zod --target stripe@23.0.0` would upgrade zod to 23.0.0, or fail late.
            if (flags.target) parseTargets([flags.target], [only]);
            if (flags.pr && !flags.yes)
              io.err('--pr without --yes: the publication plan is printed, nothing is pushed.\n');
            const repo = await progress.phase(
              'Repository',
              async () => {
                const found = await detectRepo(cwd, engine.workspaces);
                requireFixable(found, only);
                const deps = await locateDependencies(found, engine, [only]);
                if (deps.every((d) => d.workspaces.length === 0))
                  throw notADependency(found, [only]);
                requireInstalled(found, deps);
                return found;
              },
              describeRepo,
            );
            // Without a terminal there is no live line: say what started, then how long it took.
            if (quiet && !ui.interactive)
              io.err(`uptide fix · ${only} · ${repoLine(headerOf(repo, 0))}\n`);
            // --pr: GitHub and the target repository are settled before any clone is made.
            if (flags.pr && engine.publishTarget) {
              const target = await engine.publishTarget(repo.root);
              io.err(
                `PR will be opened on ${target.nameWithOwner} (base ${target.base})${target.parent ? `, a fork of ${target.parent}; use \`uptide pr --repo ${target.parent}\` afterwards to open it there` : ''}\n`,
              );
            }
            // A pin run edits by rule alone: no assistant, so nothing to say about one.
            const llm = flags.llm !== false && !flags.pinCurrentApi;
            if (flags.pinCurrentApi)
              io.err(
                'pin run: the SDK stays, apiVersion is written on each client; no code leaves this machine\n',
              );
            else if (!llm) io.err('assisted fixes off (--no-llm): no code leaves this machine\n');
            else if (selection.available) {
              io.err(
                `LLM: ${selection.provider} / ${selection.model} · budget $${maxCost.toFixed(2)}\n`,
              );
              io.err(assistedNote(selection.provider));
              const price = priceFor(selection.provider, selection.model);
              if (price.fallback)
                io.err(
                  `Unknown model pricing: using ${selection.provider}'s highest listed rates (${PRICE_DATE}) for cost and budget.\n`,
                );
              if (selection.baseUrl)
                io.err(
                  'OPENAI_BASE_URL override: compatible, not verified; endpoint pricing may differ.\n',
                );
            } else io.err(noApiKeyNote(only));
            if (!hasPack)
              io.err(
                `${only} has no migration pack (generic tier): every fix comes from the agent, up to $${(maxCost ?? 1).toFixed(2)} (--max-cost)\n`,
              );
            fixEngineStarted = true;
            const report = await progress.phase(
              flags.pinCurrentApi
                ? 'Pin of the Stripe API version (scan, edits, verification)'
                : `Migration of ${only} (check, upgrade, fixes, verification)`,
              () =>
                engine.fix(
                  {
                    cwd: repo.root,
                    only,
                    target: flags.target,
                    includeDeprecated: flags.includeDeprecated,
                    ...(flags.pinCurrentApi ? { pinCurrentApi: true } : {}),
                    llm,
                    provider: selection.provider,
                    model: selection.model,
                    ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
                    withServices: flags.withServices,
                    ...(flags.keep ? { keep: true } : {}),
                    pr: flags.pr,
                    yes: flags.yes,
                  },
                  progress.event,
                ),
              (r) => `verification ${r.verification.passed ? 'passed' : 'failed'}`,
            );
            if (quiet && !ui.interactive) io.err(`done in ${elapsed(io.now() - started)}\n`);
            fixSpend = report.llm;
            telemetry?.record(() => fixMetrics(report, repo.root));
            // The report as a page, next to the stored run; the summary points at it.
            try {
              report.html = writeMigrationHtml(report, {
                version: VERSION,
                date: new Date(io.now()).toISOString(),
              });
            } catch {
              // A page is a convenience; the run stands without it.
            }
            if (flags.json) emit(report);
            else
              io.out(
                `\n${formatFixSummary(report, { color: ui.color, invocation: INVOCATION, cwd, ms: io.now() - started })}`,
              );
            io.err(whereItRan(report));
            // The plan and its warnings, now that no spinner is drawing.
            if (report.publicationLog && !flags.json) io.err(`\n${report.publicationLog}\n`);
            if (report.publication?.refused.length)
              io.err(
                `PR not opened: ${report.publication.refused.join('; ')}.\nBranch ${report.branch} stays local; nothing was pushed.\n`,
              );
            if (report.publication?.failed) {
              // The run is verified and in the repository; only the publish step is left.
              io.err(
                `PR not opened: ${report.publication.failed}\nThe verified run is in your repository. Retry the publish step alone:\n  ${INVOCATION} pr --branch ${report.branch} --yes\n`,
              );
              return EXIT.error;
            }
            return report.verification.passed ? EXIT.ok : EXIT.breaking;
          },
          { quiet: !flags.verbose },
        ),
    );

  shared(
    program
      .command('verify')
      .description('Verify the checked-out migration branch again and refresh its stored run')
      .option(
        '--with-services',
        'also run tests that need a database, cache or queue; prints the targets, requires --yes',
      )
      .option('--branch <name>', 'the migration branch (default: the branch checked out)')
      .option('--push', 'push the new commits to origin, fast-forward only; requires --yes')
      .option(
        '--keep',
        'keep the temporary clone after the run (it is kept anyway when the run fails)',
      )
      .option(
        '--yes',
        'confirm what was printed: the services (--with-services), the push (--push)',
      ),
  )
    .addHelpText(
      'after',
      `
What it does:
  For a branch \`fix\` created that got new commits, or whose run predates a check you now
  want: formats the files the migration edited, runs the related tests (fixing a test that
  fails for a known behaviour change), type-checks and lints, all as new commits on top.
  It works in a temporary clone, never in your checkout. History is never rewritten;
  \`--push --yes\` pushes the new commits from the clone, fast-forward only. The stored run
  then records the new HEAD, so \`uptide pr-body\` can update the description.

Examples:
  $ git switch uptide/zod-4.6.5 && uptide verify
${EXIT_CODES('the branch verifies: no new type errors, tests and lint pass', 'verification failed')}`,
    )
    .action(
      (
        flags: Shared & {
          withServices?: boolean;
          yes?: boolean;
          branch?: string;
          push?: boolean;
          keep?: boolean;
        },
      ) =>
        act(flags, async ({ progress, cwd }) => {
          if (!engine.verify) throw new CliError('verify is not available in this build of uptide');
          const verify = engine.verify;
          const report = await progress.phase(
            'Verification of the migration branch',
            () =>
              verify(
                {
                  cwd,
                  ...(flags.branch ? { branch: flags.branch } : {}),
                  ...(flags.withServices ? { withServices: true } : {}),
                  ...(flags.push ? { push: true } : {}),
                  ...(flags.keep ? { keep: true } : {}),
                  ...(flags.yes ? { yes: true } : {}),
                },
                progress.event,
              ),
            (r) =>
              `verification ${r.verification.passed ? 'passed' : 'failed'} at ${r.head?.slice(0, 8)}`,
          );
          if (flags.json) emit(report);
          else io.out(`\n${formatFix(report)}`);
          telemetry?.record(() => fixMetrics(report, cwd));
          io.err(whereItRan(report));
          return report.verification.passed ? EXIT.ok : EXIT.breaking;
        }),
    );

  shared(
    program
      .command('clean')
      .description('Remove temporary clones that fix and verify kept, older than 7 days')
      .option('--days <n>', 'age in days after which a kept clone is removed', '7'),
  )
    .addHelpText(
      'after',
      `
A clone is kept when its run failed, when --keep was passed, or when it holds commits that are
nowhere else. Only directories uptide created under its own temporary root are ever removed.
${EXIT_CODES('done', 'not used')}`,
    )
    .action((flags: Shared & { days?: string }) =>
      act(flags, async () => {
        if (!engine.clean) throw new CliError('clean is not available in this build of uptide');
        const days = Number(flags.days ?? 7);
        if (!Number.isFinite(days) || days < 0)
          throw new CliError(`--days ${flags.days}: expected a number of days`, {
            next: 'uptide clean --days 7',
          });
        const result = engine.clean(days);
        telemetry?.record(() => ({
          counts: { removed: result.removed.length, kept: result.kept.length },
        }));
        if (flags.json) emit(result);
        else {
          for (const path of result.removed) io.out(`removed ${path}\n`);
          io.out(
            `${result.removed.length} temporary clone${result.removed.length === 1 ? '' : 's'} removed, ${result.kept.length} newer than ${days} day${days === 1 ? '' : 's'} kept.\n`,
          );
          for (const path of result.kept) io.out(`  kept ${path}\n`);
        }
        return EXIT.ok;
      }),
    );

  shared(
    program
      .command('pr')
      .description(
        'Push a finished migration branch and open its pull request with the stored report',
      )
      .option('--branch <name>', 'the migration branch (default: the one checked out)')
      .option(
        '--repo <owner/name>',
        'where to open the PR (default: the repository origin points at, a fork included)',
      )
      .option('--draft', 'open it as a draft')
      .option('--yes', 'approve the printed plan: push the branch and open the PR'),
  )
    .addHelpText(
      'after',
      `
What it does:
  Loads the stored run for the branch (from .git, written by fix or verify), checks that the
  branch is still at the verified commit, prints which repository the PR will be opened on,
  and with --yes pushes the branch and opens the PR with the stored description.
  On a fork the PR goes to the fork itself unless --repo names the parent.

Examples:
  $ uptide pr --branch uptide/stripe-23.0.0          the plan, nothing pushed
  $ uptide pr --branch uptide/stripe-23.0.0 --yes    push and open the PR
${EXIT_CODES('PR opened (or plan printed without --yes)', 'not used')}`,
    )
    .action((flags: Shared & { branch?: string; repo?: string; draft?: boolean; yes?: boolean }) =>
      act(flags, async ({ cwd }) => {
        if (!engine.pr) throw new CliError('pr is not available in this build of uptide');
        try {
          const { url, report } = await engine.pr(
            {
              cwd,
              branch: flags.branch,
              repo: flags.repo,
              draft: flags.draft === true,
              yes: flags.yes,
            },
            (text) => io.err(`${text}\n`),
          );
          telemetry?.record(() => fixMetrics(report, cwd));
          if (flags.json) emit({ url });
          else io.out(`${url}\n`);
          return EXIT.ok;
        } catch (err) {
          if (err instanceof Error && /requires --yes/.test(err.message)) {
            io.err('Nothing pushed. Add --yes to push the branch and open the PR.\n');
            return EXIT.ok;
          }
          throw err;
        }
      }),
    );

  shared(
    program
      .command('pr-body')
      .description('Render a stored migration run and update only a PR description (no push)')
      .requiredOption('--pr <number>', 'pull request number')
      .option('--run <file>', 'stored FixReport JSON (default: .uptide/report.json)')
      .option('--preview', 'print the proposed body without updating GitHub'),
  )
    .addHelpText(
      'after',
      `
Examples:
  $ uptide pr-body --pr 82 --preview     review the proposal first
  $ uptide pr-body --pr 82               update only the description
${EXIT_CODES('description rendered (and updated unless --preview)', 'not used')}`,
    )
    .action((flags: Shared & { pr: string; run?: string; preview?: boolean }) =>
      act(flags, async ({ cwd }) => {
        if (!engine.updatePrBody)
          throw new CliError('pr-body is not available in this build of uptide');
        const result = await engine.updatePrBody({
          pr: flags.pr,
          cwd,
          run: flags.run,
          preview: flags.preview,
        });
        if (flags.json) emit(result);
        else {
          io.out(result.body);
          io.err(
            `${result.updated ? 'Updated description:' : 'Preview only; PR unchanged:'} ${result.url}\n`,
          );
        }
        return EXIT.ok;
      }),
    );

  program
    .command('diff')
    .description('Diff the public API of an npm package between two versions')
    .argument('<package>', 'npm package name')
    .argument('<from>', 'version A (exact version or dist-tag)')
    .argument('<to>', 'version B (exact version or dist-tag)')
    .option('--json', 'print the full Change[] as JSON')
    .option(
      '--all',
      'also show protected/@internal symbols, alias duplicates and members of removed symbols',
    )
    .option('--ci', 'plain output for logs: no color, no spinner')
    .option('--no-color', 'no color (NO_COLOR is respected too)')
    .action((name: string, from: string, to: string, flags: Shared & { all?: boolean }) =>
      act(flags, async ({ ui, progress }) => {
        const changes = await progress.phase(
          `Diff of ${name} ${from} → ${to}`,
          () => engine.diff(name, from, to),
          (c) => `${c.length} changes`,
        );
        telemetry?.record(() => ({
          packages: [{ name, versions: [changes[0]?.from ?? from, changes[0]?.to ?? to] }],
          counts: { changes: changes.length },
        }));
        if (flags.json) emit(changes);
        else io.out(formatHuman(changes, { all: flags.all, color: ui.color }));
        return EXIT.ok;
      }),
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    // Help and --version are answers, not failures; anything else is a usage error.
    return err.exitCode === 0 ? EXIT.ok : EXIT.error;
  }
  if (fixing)
    io.err(
      fixSpend
        ? `LLM spend: $${fixSpend.costUsd.toFixed(6)}${fixSpend.unreportedCostUsd ? `; up to $${fixSpend.unreportedCostUsd.toFixed(6)} reserved for calls without usage` : ''}\n`
        : fixEngineStarted
          ? 'LLM spend: unavailable (the run ended before returning a usage report).\n'
          : 'LLM spend: $0.000000 (no LLM calls).\n',
    );
  telemetry?.finish(code);
  return code;
}
