import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { UptideError } from '../errors.js';

/**
 * An empty directory to point `core.hooksPath` at: no hook of the repository can run from it.
 * One fixed directory, created on demand, so runs do not leave a new one behind each time.
 */
export function noHooksDir(): string {
  const dir = join(tmpdir(), 'uptide-no-hooks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * What every install, build and test command runs with: lifecycle scripts off for npm, pnpm
 * (both the `npm_config_` and the `pnpm_config_` spelling) and yarn, the hook installers told
 * to stay out (`simple-git-hooks`, husky, lefthook), pnpm's implicit install-before-run off
 * (it is what ran `prepare` behind a plain `pnpm build`), and git itself pointed at an empty
 * hooks directory for any git command a script starts.
 */
export function quietEnv(): NodeJS.ProcessEnv {
  return {
    CI: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_enable_pre_post_scripts: 'false',
    npm_config_verify_deps_before_run: 'false',
    pnpm_config_ignore_scripts: 'true',
    pnpm_config_enable_pre_post_scripts: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    SKIP_SIMPLE_GIT_HOOKS: '1',
    HUSKY: '0',
    LEFTHOOK: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: noHooksDir(),
  };
}
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export interface CommandResult {
  code: number;
  output: string;
  timeout: boolean;
}
/** Explicit install/test commands only. Kill the whole process group on timeout. */
export function command(
  cwd: string,
  bin: string,
  args: string[],
  timeoutMs = 120_000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let timeout = false;
    const child = spawn(bin, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/(?:TOKEN|SECRET|API_KEY|PASSWORD)/i.test(key),
          ),
        ),
        ...quietEnv(),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timeout = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* process already exited */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(e), timeout: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timeout });
    });
  });
}

/**
 * The project a run belongs to: the top-most directory with a package.json between `cwd`
 * and the git top level. A JavaScript project may live below the repository root (a
 * `frontend/` next to a Python backend); a run from inside one of its workspaces is refused,
 * since every workspace declaring the dependency is upgraded together.
 */
export function projectRoot(cwd: string): { root: string; top: string; project: string } {
  const root = realpathSync(resolve(cwd));
  const top = realpathSync(git(root, 'rev-parse', '--show-toplevel'));
  if (!existsSync(join(root, 'package.json')))
    throw new UptideError(
      'NOT_REPOSITORY_ROOT',
      `${root}: no package.json; run fix at the project root`,
    );
  for (let dir = dirname(root); dir.startsWith(top) && dir !== root; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')))
      throw new UptideError(
        'NOT_REPOSITORY_ROOT',
        `run fix at the project root, ${dir} (workspace versions are upgraded together)`,
      );
    if (dir === top) break;
  }
  return { root, top, project: relative(top, root) || '.' };
}
