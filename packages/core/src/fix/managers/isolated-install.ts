import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { workspacePackagesOf } from '../../adapters/typescript/repo.js';
import { git } from '../process.js';
import { packageManager } from './manager.js';
import { type InstallReport, type Upgrade, upgradeInstall } from './upgrade.js';

function relocateLinks(dir: string, from: string, to: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) relocateLinks(file, from, to);
    if (!entry.isSymbolicLink()) continue;
    const link = readlinkSync(file);
    if (isAbsolute(link) && link.startsWith(`${from}/`)) {
      rmSync(file);
      symlinkSync(join(to, relative(from, link)), file);
    }
  }
}
/** Promote only a validated lockfile and its already-installed dependencies. No install runs on the branch. */
export async function isolatedUpgrade(
  root: string,
  upgrade: Upgrade,
  execute = upgradeInstall,
): Promise<InstallReport> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'uptide-install-')));
  // The worktree is the whole repository; the project may live below its top level.
  const worktree = join(scratch, 'repo');
  const checkout = join(
    worktree,
    relative(realpathSync(git(root, 'rev-parse', '--show-toplevel')), realpathSync(root)),
  );
  const staging = mkdtempSync(join(root, '.uptide-install-'));
  let registered = false;
  const swapped: { target: string; backup: string; existed: boolean }[] = [];
  const pm = packageManager(root);
  const lock = join(root, pm.lockfile),
    originalLock = readFileSync(lock);
  try {
    git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
    registered = true;
    for (const file of new Set([...upgrade.files, '.npmrc', '.yarnrc', '.yarnrc.yml'])) {
      const source = resolve(root, file);
      if (!source.startsWith(`${root}/`))
        throw new Error(`Install input escapes repository: ${file}`);
      if (!existsSync(source)) continue;
      const destination = join(checkout, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
    const result = await execute(checkout, upgrade);
    const generated = readFileSync(join(checkout, pm.lockfile));
    const modules: { target: string; staged?: string; backup: string }[] = [];
    for (const [i, workspace] of workspacePackagesOf(root).entries()) {
      const source = join(checkout, workspace, 'node_modules');
      const target = join(root, workspace, 'node_modules');
      if (!existsSync(source) && !existsSync(target)) continue;
      const staged = existsSync(source) ? join(staging, `new-${i}`) : undefined;
      if (staged) {
        cpSync(source, staged, { recursive: true, verbatimSymlinks: true });
        relocateLinks(staged, checkout, root);
      }
      modules.push({
        target: join(root, workspace, 'node_modules'),
        staged,
        backup: join(staging, `old-${i}`),
      });
    }
    for (const { target, staged, backup } of modules) {
      const existed = existsSync(target);
      if (existed) renameSync(target, backup);
      swapped.push({ target, backup, existed });
      if (staged) renameSync(staged, target);
    }
    writeFileSync(lock, generated);
    return result;
  } catch (error) {
    writeFileSync(lock, originalLock);
    for (const { target, backup, existed } of swapped.reverse()) {
      rmSync(target, { recursive: true, force: true });
      if (existed) renameSync(backup, target);
    }
    throw error;
  } finally {
    if (registered) git(root, 'worktree', 'remove', '--force', worktree);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
