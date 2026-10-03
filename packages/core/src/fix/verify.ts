import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { Project, ts } from 'ts-morph';
import { readInstalled } from '../adapters/typescript/repo.js';
import { workspaceSourceMap } from '../adapters/typescript/workspace-source.js';
import { UptideError } from '../errors.js';
import { command } from './process.js';
import { isServiceTest, serviceNeeds, unitConfig } from './services.js';
import type { FixDiagnostic, TestResult } from './types.js';

/** The consumer's compiler is authoritative; bundles carry ts-morph's compiler as fallback. */
export function resolveCompiler(
  dir: string,
  bundled: typeof ts | undefined = ts,
  load = (path: string) => createRequire(path)('typescript') as typeof ts,
): typeof ts {
  try {
    return load(join(dir, 'package.json'));
  } catch {
    if (bundled) return bundled;
    throw new UptideError(
      'TYPESCRIPT_UNAVAILABLE',
      'TypeScript compiler unavailable: install typescript in the consumer repository or reinstall the Uptide bundle',
    );
  }
}

let bundledLibraries: Map<string, string> | undefined;
function bundledHost(options: ts.CompilerOptions): ts.CompilerHost {
  if (!bundledLibraries?.has(ts.getDefaultLibFileName(options))) {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: options.target ?? ts.ScriptTarget.ES2025 },
    });
    project.createSourceFile('probe.ts', 'const value = 1;');
    bundledLibraries = new Map(
      project
        .getProgram()
        .compilerObject.getSourceFiles()
        .filter((f) => f.fileName.includes('/typescript/lib/'))
        .map((f) => [basename(f.fileName), f.text]),
    );
  }
  const host = ts.createCompilerHost(options);
  const read = host.readFile,
    exists = host.fileExists;
  const lib = (file: string) =>
    file.startsWith('/__uptide_lib__/') ? bundledLibraries?.get(basename(file)) : undefined;
  host.readFile = (file) => lib(file) ?? read(file);
  host.fileExists = (file) => lib(file) !== undefined || exists(file);
  host.getDefaultLibLocation = () => '/__uptide_lib__';
  host.getDefaultLibFileName = (o) => join('/__uptide_lib__', ts.getDefaultLibFileName(o));
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  return host;
}

/** Fresh programs after every edit; workspace dependencies resolve from source through loadRepo. */
/**
 * What a TS2322/TS2345 asked for, as a shape: the contextual type at the offending
 * expression, its properties one level deep with aliases expanded. `Type 'string' is not
 * assignable to type 'BillingCycleAnchor'` says nothing a migration can use;
 * `{ type: "now" | "unchanged" | OtherString }` does. Best effort against the repository's
 * own compiler: anything it cannot answer is simply absent.
 */
function expectedShape(
  compiler: typeof ts,
  program: ts.Program,
  d: ts.Diagnostic,
): string | undefined {
  if (!d.file || d.start === undefined || ![2322, 2345].includes(d.code)) return undefined;
  try {
    const checker = program.getTypeChecker();
    let node: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      if (n.getStart() <= (d.start as number) && (d.start as number) < n.getEnd()) {
        node = n;
        n.forEachChild(visit);
      }
    };
    d.file.forEachChild(visit);
    // The expression the type was wanted for: the initializer of the property named at the
    // error, or the argument the error points at.
    let expression: ts.Node | undefined = node;
    while (expression && !compiler.isExpression(expression)) expression = expression.parent;
    if (expression && compiler.isPropertyAssignment(expression.parent))
      expression = expression.parent.initializer;
    if (!expression || !compiler.isExpression(expression)) return undefined;
    const type = checker.getContextualType(expression);
    if (!type) return undefined;
    const flags = compiler.TypeFormatFlags.NoTruncation | compiler.TypeFormatFlags.InTypeAlias;
    // `import("/.../stripe/esm/shared").OtherString` is `OtherString` to a reader.
    const plain = (text: string): string => text.replace(/import\("[^"]*"\)\./g, '');
    const print = (t: ts.Type, f = flags): string => plain(checker.typeToString(t, expression, f));
    // An optional property's contextual type carries `undefined`; the property does not.
    const parts = (type.isUnion() ? type.types : [type]).filter(
      (t) => !(t.flags & compiler.TypeFlags.Undefined),
    );
    const members = (t: ts.Type): string | undefined => {
      const props = t.getProperties();
      if (props.length === 0 || props.length > 12) return undefined;
      return `{ ${props
        .map((p) => {
          const optional = p.flags & compiler.SymbolFlags.Optional ? '?' : '';
          const own = checker.getTypeOfSymbolAtLocation(p, expression as ts.Node);
          return `${p.name}${optional}: ${print(own).replace(/ \| undefined$/, '')}`;
        })
        .join('; ')} }`;
    };
    const name = parts.map((t) => print(t, compiler.TypeFormatFlags.NoTruncation)).join(' | ');
    const shape = parts.map((t) => members(t) ?? print(t)).join(' | ');
    if (shape === name) return undefined;
    return `${name}: ${shape}`.slice(0, 600);
  } catch {
    return undefined;
  }
}

export function diagnostics(root: string, workspaces: string[]): FixDiagnostic[] {
  const all = new Map<string, FixDiagnostic>();
  const queue = [...workspaces];
  const visited = new Set<string>();
  for (const workspace of queue) {
    if (visited.has(workspace)) continue;
    visited.add(workspace);
    const dir = join(root, workspace);
    const compiler = resolveCompiler(dir);
    const config = compiler.readConfigFile(join(dir, 'tsconfig.json'), compiler.sys.readFile);
    const parsed = compiler.parseJsonConfigFileContent(
      config.config ?? {
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules', 'dist', 'build'],
      },
      compiler.sys,
      dir,
    );
    const sources = workspaceSourceMap(dir, readInstalled(dir).installed);
    const fileNames = new Set(parsed.fileNames);
    for (const reference of parsed.projectReferences ?? []) {
      const path = reference.path.endsWith('.json')
        ? reference.path
        : join(reference.path, 'tsconfig.json');
      const ref = compiler.readConfigFile(path, compiler.sys.readFile);
      const files = compiler.parseJsonConfigFileContent(
        ref.config ?? {},
        compiler.sys,
        dirname(path),
      ).fileNames;
      for (const f of files) fileNames.add(f);
    }
    if (compiler === ts) parsed.options.ignoreDeprecations = '6.0';
    const program = compiler.createProgram({
      ...(compiler === ts
        ? { host: bundledHost({ ...parsed.options, noEmit: true, skipLibCheck: true }) }
        : {}),
      rootNames: [...fileNames],
      options: {
        ...parsed.options,
        noEmit: true,
        rootDir: root,
        composite: false,
        incremental: false,
        paths: { ...parsed.options.paths, ...sources.paths },
      },
    });
    const errors = [
      ...parsed.errors,
      ...(config.error ? [config.error] : []),
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ];
    for (const file of program.getSourceFiles()) {
      if (
        file.isDeclarationFile ||
        !file.fileName.startsWith(`${root}/`) ||
        file.fileName.includes('/node_modules/')
      )
        continue;
      // Source dependencies provide types to this program, but their implementation
      // diagnostics belong to their own tsconfig (module resolution may differ).
      let owner = dirname(file.fileName);
      while (owner !== root && !existsSync(join(owner, 'tsconfig.json'))) owner = dirname(owner);
      if (owner !== dir && owner !== root) {
        const other = relative(root, owner);
        if (!visited.has(other)) queue.push(other);
        continue;
      }
      errors.push(
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      );
    }
    for (const d of errors) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const location = d.file?.getLineAndCharacterOfPosition(d.start ?? 0);
      const expected = expectedShape(compiler, program, d);
      const value: FixDiagnostic = {
        file: d.file ? relative(root, d.file.fileName) : join(workspace, 'tsconfig.json'),
        line: (location?.line ?? 0) + 1,
        column: (location?.character ?? 0) + 1,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n').split(root).join('<repo>'),
        ...(expected ? { expected } : {}),
      };
      all.set(`${value.file}:${value.line}:${value.column}:${value.code}:${value.message}`, value);
    }
  }
  return [...all.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}
const key = (d: FixDiagnostic) => `${d.file}|${d.code}|${d.message.replace(/\s+/g, ' ')}`;
/** Multiset subtraction ignores shifted lines but retains duplicate diagnostics. */
export function newDiagnostics(
  baseline: FixDiagnostic[],
  target: FixDiagnostic[],
): FixDiagnostic[] {
  const counts = new Map<string, number>();
  for (const d of baseline) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
  return target.filter((d) => {
    const n = counts.get(key(d)) ?? 0;
    if (n) {
      counts.set(key(d), n - 1);
      return false;
    }
    return true;
  });
}
/** One test run `fix` will make: where, with what, and how to describe it in the report. */
export interface TestPlan {
  /** The workspace the result is reported under: its own path, or the directory of a shared config. */
  workspace: string;
  /** Workspaces this run answers for. */
  covers: string[];
  cwd: string;
  /** The command as a person would type it from `cwd`. */
  command: string;
  /** How the scope was chosen, in words for the report. */
  scope: string;
  /** A file the run needs and that is removed afterwards: the unit-only runner configuration. */
  write?: { path: string; text: string };
  /** Integration and end-to-end test files left out because they need services. */
  notRun?: { files: number; needs: string[] };
  /** With `withServices`: what the run connects to. */
  services?: { names: string[]; targets: string[] };
}

export interface TestOptions {
  /**
   * Also run tests that need a database, a cache or a queue, with the repository's global
   * setup. Off by default: such a setup connects to whatever the environment points at and
   * may reset it, and verification must not touch the user's services uninvited.
   */
  withServices?: boolean;
}

const VITEST_CONFIGS = ['vitest.config', 'vitest.workspace'].flatMap((base) =>
  ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${base}.${ext}`),
);
const JEST_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map(
  (ext) => `jest.config.${ext}`,
);
const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

function manifest(dir: string): { scripts?: Record<string, string>; jest?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Directories from `from` up to `root`, nearest first. */
function upTo(root: string, from: string): string[] {
  const dirs: string[] = [];
  for (let dir = from; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === root || dirname(dir) === dir) break;
  }
  return dirs;
}

/** The nearest vitest or jest configuration covering a workspace, with a runner installed for it. */
function runnerFor(
  root: string,
  workspace: string,
): { runner: 'vitest' | 'jest'; dir: string; config: string } | undefined {
  for (const dir of upTo(root, join(root, workspace))) {
    const installed = (bin: string): boolean =>
      upTo(root, dir).some((d) => existsSync(join(d, 'node_modules/.bin', bin)));
    const vitest = VITEST_CONFIGS.find((name) => existsSync(join(dir, name)));
    if (vitest && installed('vitest')) return { runner: 'vitest', dir, config: vitest };
    const jest =
      JEST_CONFIGS.find((name) => existsSync(join(dir, name))) ??
      (manifest(dir)?.jest ? 'package.json' : undefined);
    if (jest && installed('jest')) return { runner: 'jest', dir, config: jest };
  }
  return undefined;
}

/**
 * The same detection for every run, baseline and target alike. Per workspace, in order: its
 * own `test` script; a vitest or jest configuration that covers it (its own or an ancestor's,
 * as in a monorepo with one root config), scoped to the affected files with the runner's
 * related-tests mode, or to the workspace directory when no file is known; the root `test`
 * script. Workspaces sharing a configuration share one run. Whatever is left has no tests.
 */
export function planTests(
  root: string,
  workspaces: string[],
  files: string[] = [],
  options: TestOptions = {},
): TestPlan[] {
  const plans: TestPlan[] = [];
  const shared = new Map<
    string,
    { runner: 'vitest' | 'jest'; dir: string; config: string; covers: string[] }
  >();
  const rootScript: string[] = [];
  for (const workspace of workspaces) {
    const script = manifest(join(root, workspace))?.scripts?.test;
    // A script that is just the runner is planned as the runner: scoped, and classified.
    const bare = /^\s*(?:(?:npx|pnpm exec|yarn)\s+)?(vitest|jest)\b/.exec(script ?? '')?.[1];
    if (script && !(bare && runnerFor(root, workspace)?.runner === bare)) {
      plans.push({
        workspace,
        covers: [workspace],
        cwd: join(root, workspace),
        command: script,
        scope: `the \`test\` script of ${workspace === '.' ? 'the repository' : workspace}`,
      });
      continue;
    }
    const found = runnerFor(root, workspace);
    if (found) {
      const key = `${found.runner}:${found.dir}`;
      const group = shared.get(key) ?? { ...found, covers: [] };
      group.covers.push(workspace);
      shared.set(key, group);
      continue;
    }
    if (workspace !== '.' && manifest(root)?.scripts?.test) rootScript.push(workspace);
    else
      plans.push({
        workspace,
        covers: [workspace],
        cwd: join(root, workspace),
        command: '',
        scope: 'no test script, and no vitest or jest configuration covers this workspace',
      });
  }
  for (const group of shared.values()) {
    const inside = (file: string): boolean =>
      group.covers.some((w) => w === '.' || file === w || file.startsWith(`${w}/`));
    const related = [...new Set(files)]
      .filter(inside)
      .filter((file) => existsSync(join(root, file)))
      .map((file) => relative(group.dir, join(root, file)))
      .sort();
    const dirs = group.covers.map((w) => relative(group.dir, join(root, w)) || '.');
    const where = relative(root, join(group.dir, group.config)) || group.config;
    // Tests that need a database or a queue, and a global setup that connects to one, are
    // opt-in: by default only what runs without services runs.
    const needs = serviceNeeds(root, group.dir, group.config, group.covers);
    const sensitive = needs.files.length > 0 || needs.setups.length > 0;
    const unitOnly = sensitive && !options.withServices;
    const needsText = needs.services.length ? needs.services : ['services'];
    const workspace = relative(root, group.dir) || '.';
    const wrapper = 'vitest.uptide-unit.config.mjs';
    const canIsolate =
      group.runner === 'vitest'
        ? group.config.startsWith('vitest.config.')
        : needs.setups.length === 0;
    if (unitOnly && !canIsolate) {
      // The global setup cannot be taken out of this configuration: nothing runs, and it says so.
      plans.push({
        workspace,
        covers: group.covers,
        cwd: group.dir,
        command: '',
        scope: `not run: the ${group.runner} setup in ${where} connects to ${needsText.join(', ')}; pass --with-services to include it`,
        notRun: { files: needs.files.length, needs: needsText },
      });
      continue;
    }
    const targets = unitOnly ? related.filter((file) => !isServiceTest(file)) : related;
    const isolate = !unitOnly
      ? []
      : group.runner === 'vitest'
        ? ['--config', wrapper]
        : ['--testPathIgnorePatterns', '\\.(integration|int|e2e)\\.', '/(integration|e2e)/'];
    const args =
      group.runner === 'vitest'
        ? targets.length
          ? ['related', '--run', '--passWithNoTests', ...isolate, ...targets]
          : ['run', '--passWithNoTests', ...isolate, ...dirs.filter((d) => d !== '.')]
        : targets.length
          ? ['--findRelatedTests', '--passWithNoTests', ...isolate, ...targets]
          : ['--passWithNoTests', ...isolate, ...dirs.filter((d) => d !== '.')];
    // Calling the runner directly skips npm's `pretest` hook. When the repository's own test
    // script is this runner, its `pretest` (typically a build of workspace packages the tests
    // import) is part of how the tests are meant to run, so it runs first, as a command of its
    // own and never through the lifecycle hook.
    const scripts = manifest(group.dir)?.scripts;
    const prepare =
      scripts?.pretest && new RegExp(`\\b${group.runner}\\b`).test(scripts.test ?? '')
        ? scripts.pretest
        : undefined;
    const run = [group.runner, ...args.map(quote)].join(' ');
    const kind = unitOnly ? 'unit tests' : 'tests';
    plans.push({
      workspace,
      covers: group.covers,
      cwd: group.dir,
      command: prepare ? `${prepare} && ${run}` : run,
      scope: `${
        targets.length
          ? `${group.runner} ${kind} related to ${targets.length} affected file${targets.length === 1 ? '' : 's'}`
          : `${group.runner} ${kind} under ${dirs.join(', ')}`
      }, ${where}${prepare ? ' after `pretest`' : ''}`,
      ...(unitOnly && group.runner === 'vitest'
        ? {
            write: {
              path: join(group.dir, wrapper),
              text: unitConfig(group.config, needs.setups.length > 0),
            },
          }
        : {}),
      ...(unitOnly ? { notRun: { files: needs.files.length, needs: needsText } } : {}),
      ...(sensitive && options.withServices
        ? { services: { names: needsText, targets: needs.targets } }
        : {}),
    });
  }
  if (rootScript.length)
    plans.push({
      workspace: '.',
      covers: rootScript,
      cwd: root,
      command: manifest(root)?.scripts?.test ?? '',
      scope: 'the `test` script of the repository',
    });
  return plans;
}

/** `270 tests in 41 files`, read from what vitest or jest printed; nothing when neither did. */
export function testSummary(output: string): string | undefined {
  const plain = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const tests = /^\s*Tests:?\s+(?:.*?,\s*)?(\d+) passed/m.exec(plain)?.[1];
  const files = /^\s*Test (?:Files|Suites):?\s+(?:.*?,\s*)?(\d+) passed/m.exec(plain)?.[1];
  if (!tests) return undefined;
  const n = Number(tests);
  return `${n} test${n === 1 ? '' : 's'}${files ? ` in ${files} file${files === '1' ? '' : 's'}` : ''}`;
}

/** Test files a vitest or jest run reports as failed, as the runner printed them. */
export function failedTestFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/^\s*FAIL\b/.test(line)) continue;
    const file = /([\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(line)?.[1];
    if (file) files.add(file);
  }
  return [...files].sort();
}

const stem = (file: string): string =>
  (file.split('/').pop() ?? file).replace(
    /(?:\.(?:e2e|integration))?(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/,
    '',
  );
/** Whether a failing test file is about one of the affected files: the file itself, or its test. */
function concerns(testFile: string, affected: string[]): boolean {
  return affected.some(
    (file) => file.endsWith(testFile) || testFile.endsWith(file) || stem(file) === stem(testFile),
  );
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
export async function testWorkspaces(
  root: string,
  workspaces: string[],
  timeoutMs = 120_000,
  files: string[] = [],
  options: TestOptions = {},
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The path as given is all there is.
  }
  for (const plan of planTests(root, workspaces, files, options)) {
    const described = {
      covers: plan.covers,
      scope: plan.scope,
      ...(plan.notRun ? { notRun: plan.notRun } : {}),
      ...(plan.services ? { services: plan.services } : {}),
    };
    if (!plan.command) {
      results.push({
        workspace: plan.workspace,
        status: 'missing',
        output: plan.scope,
        ...described,
      });
      continue;
    }
    const bins = upTo(root, plan.cwd)
      .map((dir) => join(dir, 'node_modules/.bin'))
      .filter((dir) => existsSync(dir));
    const attempt = () =>
      command(plan.cwd, process.env.SHELL ?? '/bin/sh', ['-c', plan.command], timeoutMs, {
        PATH: [...bins, process.env.PATH].join(':'),
      });
    // Stored and published as text: no terminal colors, no path of this machine.
    const plain = (text: string): string =>
      text.replace(ANSI, '').split(realRoot).join('<repo>').split(root).join('<repo>');
    if (plan.write) writeFileSync(plan.write.path, plan.write.text);
    let result: Awaited<ReturnType<typeof attempt>>;
    let retried: string[] = [];
    try {
      result = await attempt();
      if (result.code && !result.timeout) {
        // A failure in a test that is not about the affected files gets one more run: a socket
        // reset in an unrelated e2e test must not fail a migration. A test of an affected file
        // that fails is ours, and is never retried into a pass.
        const failing = failedTestFiles(plain(result.output));
        if (failing.length > 0 && failing.every((file) => !concerns(file, files))) {
          const again = await attempt();
          if (!again.code && !again.timeout) retried = failing;
          result = again;
        }
      }
    } finally {
      // The unit-only configuration exists for the run alone.
      if (plan.write) rmSync(plan.write.path, { force: true });
    }
    const output = plain(result.output);
    const summary = testSummary(output);
    // The runner passed with nothing to run: that is "no tests", not a green suite.
    const empty =
      !result.code &&
      !result.timeout &&
      /No test files found|No tests found/i.test(output) &&
      !summary;
    results.push({
      workspace: plan.workspace,
      status: result.timeout ? 'timeout' : result.code ? 'failed' : empty ? 'missing' : 'passed',
      output: empty ? `no tests are related to the affected files (${plan.command})` : output,
      command: plan.command,
      ...described,
      ...(summary ? { summary } : {}),
      ...(retried.length ? { retried } : {}),
    });
  }
  return results;
}

/**
 * What `--with-services` would reach in this repository, in words: the services, where they
 * are, and the setup that runs against them. Empty when no test needs a service.
 */
export function describeServices(root: string, workspaces: string[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const found = runnerFor(root, workspace);
    if (!found || seen.has(`${found.runner}:${found.dir}`)) continue;
    seen.add(`${found.runner}:${found.dir}`);
    const needs = serviceNeeds(root, found.dir, found.config, workspaces);
    if (needs.files.length === 0 && needs.setups.length === 0) continue;
    const names = needs.services.length ? needs.services.join(', ') : 'services not identified';
    lines.push(
      `${names}: ${needs.files.length} integration or end-to-end test file${needs.files.length === 1 ? '' : 's'}${needs.setups.length ? `, global setup ${needs.setups.join(', ')} runs against it and may reset data` : ''}`,
      ...needs.targets.map((target) => `  ${target}`),
    );
  }
  return lines;
}

/**
 * Failures the migration did not cause: a workspace whose run failed before the change with
 * the same test files (or, when the runner names none, failed at all). They are marked, not
 * counted against verification; a new failing file is still a failure.
 */
export function markPreexisting(tests: TestResult[], baseline: TestResult[]): TestResult[] {
  return tests.map((t) => {
    if (t.status !== 'failed') return t;
    const before = baseline.find(
      (b) => b.workspace === t.workspace && (b.status === 'failed' || b.status === 'timeout'),
    );
    if (!before) return t;
    const now = failedTestFiles(t.output);
    const then = new Set(failedTestFiles(before.output));
    if (now.length === 0 && then.size === 0) return { ...t, preexisting: ['*'] };
    if (now.length > 0 && now.every((f) => then.has(f))) return { ...t, preexisting: now };
    return t;
  });
}
