import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workspacePackagesOf } from '../../adapters/typescript/repo.js';
import { UptideError } from '../../errors.js';
import { satisfies, validRange } from '../../fetch/range.js';
import type { Manifest } from '../../list/evidence.js';
import { packageManager } from './manager.js';

/** Compare the committed declarations and locked resolutions without running an install. */
export function assertNpmLockSync(
  root: string,
  read = (file: string) => readFileSync(join(root, file), 'utf8'),
): void {
  const pm = packageManager(root);
  if (pm.kind !== 'npm') return;
  const lock = JSON.parse(read(pm.lockfile)) as {
    packages: Record<string, Manifest & { link?: boolean; resolved?: string }>;
  };
  const fail = (detail: string): never => {
    throw new UptideError(
      'LOCKFILE_OUT_OF_SYNC',
      `the lockfile does not match package.json; run npm install first (${pm.lockfile}: ${detail})`,
    );
  };
  for (const workspace of workspacePackagesOf(root)) {
    const file = join(workspace, 'package.json');
    const manifest = JSON.parse(read(file)) as Manifest;
    const importer = workspace === '.' ? '' : workspace.replaceAll('\\', '/');
    const locked = lock.packages?.[importer];
    if (!locked) fail(`${file} has no importer`);
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ] as const) {
      const declared = manifest[field] ?? {};
      const recorded = locked?.[field] ?? {};
      for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
        if (declared[name] !== recorded[name]) fail(`${file} ${field}.${name}`);
        // Peers can be supplied by the consumer, optional dependencies by another platform.
        if (field === 'peerDependencies' || field === 'optionalDependencies') continue;
        let at = importer;
        let entry: (typeof lock.packages)[string] | undefined;
        for (;;) {
          entry = lock.packages[`${at ? `${at}/` : ''}node_modules/${name}`];
          if (entry || !at) break;
          const parent = dirname(at);
          at = parent === '.' ? '' : parent;
        }
        if (!entry) fail(`${file} ${name} is missing`);
        if (entry?.link) continue;
        const range = declared[name];
        if (range && validRange(range) && (!entry?.version || !satisfies(entry.version, range)))
          fail(`${file} ${name} ${entry?.version ?? 'missing'} does not satisfy ${range}`);
      }
    }
  }
}
