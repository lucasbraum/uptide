import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNpm, parsePnpm, parseYarn } from '../../adapters/typescript/lockfile.js';
import { UptideError } from '../../errors.js';
import { command } from '../process.js';
import { assertManagerAvailable } from './availability.js';
import { assertLockScope, type LockDiff, type LockGraph } from './lock-guard.js';
import { type PackageManager, updateArgs } from './manager.js';
import { npmGraph } from './npm-lock.js';
import { pnpmGraph, yarnGraph } from './text-lock.js';
export interface Upgrade {
  name: string;
  version: string;
  workspaces: string[];
  files: string[];
}
export interface InstallReport extends LockDiff {
  manager: string;
  file: string;
}
export function lockGraph(pm: PackageManager, text: string, target: string): LockGraph {
  return pm.kind === 'npm'
    ? npmGraph(text, target)
    : pm.kind === 'pnpm'
      ? pnpmGraph(text, target)
      : yarnGraph(text, target);
}
async function run(root: string, pm: PackageManager, args: string[]): Promise<void> {
  const result = await command(root, pm.bin, args, 300_000, {
    ...pm.env,
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
  });
  if (result.code)
    throw new UptideError(
      'INSTALL_FAILED',
      `${pm.bin} ${args.join(' ')} failed${result.timeout ? ' (timeout)' : ''}: ${result.output}`,
    );
}
/** Resolution changes are checked before they can become an upgrade commit. */
export async function upgradeInstall(root: string, upgrade: Upgrade): Promise<InstallReport> {
  const pm = await assertManagerAvailable(root);
  const lockfile = join(root, pm.lockfile);
  const beforeText = readFileSync(lockfile, 'utf8');
  const before = lockGraph(pm, beforeText, upgrade.name);
  const originals = new Map(
    upgrade.files
      .filter((f) => f.endsWith('package.json'))
      .map((f) => [f, readFileSync(join(root, f), 'utf8')]),
  );
  const rootManifest = join(root, 'package.json');
  const rootText = readFileSync(rootManifest, 'utf8');
  const yarn = pm.kind.startsWith('yarn');
  try {
    if (yarn) {
      const json = JSON.parse(rootText);
      json.resolutions = { ...json.resolutions, [upgrade.name]: upgrade.version };
      writeFileSync(rootManifest, `${JSON.stringify(json, null, 2)}\n`);
    } else if (pm.kind === 'npm') {
      // Resolve an exact version first, then restore range style; npm reuses this satisfying lock entry.
      for (const [file, text] of originals) {
        const json = JSON.parse(text);
        for (const section of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ])
          if (json[section]?.[upgrade.name]) json[section][upgrade.name] = upgrade.version;
        writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
      }
    }
    await run(root, pm, updateArgs(pm, root, upgrade.workspaces));
  } finally {
    for (const [file, text] of originals) writeFileSync(join(root, file), text);
    if (yarn) writeFileSync(rootManifest, rootText);
  }
  // Let the real manager reconcile the final manifest, including its original range operator.
  if (yarn || pm.kind === 'npm') await run(root, pm, updateArgs(pm, root, upgrade.workspaces));
  const afterText = readFileSync(lockfile, 'utf8');
  const diff = assertLockScope(before, lockGraph(pm, afterText, upgrade.name), upgrade.name);
  for (const workspace of upgrade.workspaces) {
    const json = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
    const ranges = new Map<string, string>();
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      if (json[section]?.[upgrade.name]) ranges.set(upgrade.name, json[section][upgrade.name]);
    const parse = pm.kind === 'npm' ? parseNpm : pm.kind === 'pnpm' ? parsePnpm : parseYarn;
    const installed = parse(afterText, { importer: workspace, declared: ranges }).get(upgrade.name);
    if (installed !== upgrade.version)
      throw new UptideError(
        'INSTALL_FAILED',
        `Requested ${upgrade.name}@${upgrade.version}, but ${workspace} resolved ${installed ?? 'nothing'}; verification cannot use a different target.`,
      );
  }
  await run(root, pm, pm.args);
  if (readFileSync(lockfile, 'utf8') !== afterText)
    throw new UptideError(
      'LOCKFILE_OUT_OF_SCOPE',
      'Verification install changed the validated lockfile',
    );
  return { ...diff, manager: pm.kind, file: pm.lockfile };
}
