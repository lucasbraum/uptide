import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNpm, parsePnpm, parseYarn } from '../../adapters/typescript/lockfile.js';
import { UptideError } from '../../errors.js';
import { command } from '../process.js';
import { assertManagerAvailable } from './availability.js';
import { assertLockScope, type LockDiff, type LockGraph, type Targets } from './lock-guard.js';
import { type PackageManager, updateArgs } from './manager.js';
import { npmGraph } from './npm-lock.js';
import { pnpmGraph, yarnGraph } from './text-lock.js';
export interface Upgrade {
  name: string;
  version: string;
  workspaces: string[];
  files: string[];
  /**
   * What moves with it, each at the version that agrees (`check/companions.ts`): one install,
   * and the lockfile may change inside any of their subtrees, never outside them.
   */
  also?: { name: string; version: string }[];
}
export interface InstallReport extends LockDiff {
  manager: string;
  file: string;
}
export function lockGraph(pm: PackageManager, text: string, target: Targets): LockGraph {
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
  const moves = [{ name: upgrade.name, version: upgrade.version }, ...(upgrade.also ?? [])];
  const names = moves.map((m) => m.name);
  const before = lockGraph(pm, beforeText, names);
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
      json.resolutions = {
        ...json.resolutions,
        ...Object.fromEntries(moves.map((m) => [m.name, m.version])),
      };
      writeFileSync(rootManifest, `${JSON.stringify(json, null, 2)}\n`);
    } else {
      // Resolve an exact version first, then restore range style; npm and pnpm reuse this
      // satisfying lock entry. A range alone resolves the newest release in it: `^4.0.1` gives
      // a second @ai-sdk/provider next to the 4.0.1 that ai pins.
      for (const [file, text] of originals) {
        const json = JSON.parse(text);
        for (const section of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ])
          for (const m of moves) if (json[section]?.[m.name]) json[section][m.name] = m.version;
        writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
      }
    }
    await run(root, pm, updateArgs(pm, root, upgrade.workspaces));
  } finally {
    for (const [file, text] of originals) writeFileSync(join(root, file), text);
    if (yarn) writeFileSync(rootManifest, rootText);
  }
  // Let the real manager reconcile the final manifest, including its original range operator.
  await run(root, pm, updateArgs(pm, root, upgrade.workspaces));
  const afterText = readFileSync(lockfile, 'utf8');
  const diff = assertLockScope(before, lockGraph(pm, afterText, names), names);
  // Every package that moved resolved the version asked for, in every workspace declaring it.
  for (const workspace of upgrade.workspaces) {
    const json = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
    const ranges = new Map<string, string>();
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      for (const m of moves) if (json[section]?.[m.name]) ranges.set(m.name, json[section][m.name]);
    const parse = pm.kind === 'npm' ? parseNpm : pm.kind === 'pnpm' ? parsePnpm : parseYarn;
    const resolved = parse(afterText, { importer: workspace, declared: ranges });
    for (const m of moves) {
      if (!ranges.has(m.name)) continue;
      const installed = resolved.get(m.name);
      if (installed !== m.version)
        throw new UptideError(
          'INSTALL_FAILED',
          `Requested ${m.name}@${m.version}, but ${workspace} resolved ${installed ?? 'nothing'}; verification cannot use a different target.`,
        );
    }
  }
  await run(root, pm, pm.args);
  if (readFileSync(lockfile, 'utf8') !== afterText)
    throw new UptideError(
      'LOCKFILE_OUT_OF_SCOPE',
      'Verification install changed the validated lockfile',
    );
  return { ...diff, manager: pm.kind, file: pm.lockfile };
}
