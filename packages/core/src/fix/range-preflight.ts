import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { companionsOf, type InstalledDependency } from '../check/companions.js';
import { UptideError } from '../errors.js';
import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import { loadRegistryConfig } from '../fetch/npmrc.js';
import { installedManifest, type Manifest } from '../list/evidence.js';
import { activePack } from '../packs/index.js';
import type { FixOptions, FixServices } from './run.js';
import { resolveTarget } from './target.js';
import { validateVersionRanges } from './versions.js';

/** Resolve companions only when a declaration could block the run, before cloning or spending. */
export async function rangePreflight(
  options: FixOptions,
  services?: FixServices,
  load = (file: string) => readFileSync(join(options.cwd, file), 'utf8'),
): Promise<string | undefined> {
  if (options.pinCurrentApi) return;
  const root = options.cwd;
  const files = new Map<string, string>();
  const read = (file: string): string => {
    let text = files.get(file);
    if (text === undefined) {
      text = load(file);
      files.set(file, text);
    }
    return text;
  };
  validateVersionRanges(root, [options.only], read);
  const installed = new Map<string, InstalledDependency>();
  const names = new Set<string>();
  for (const workspace of workspacePackagesOf(root)) {
    const manifest = JSON.parse(read(join(workspace, 'package.json'))) as Manifest;
    for (const [name, spec] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      names.add(name);
      if (/^(workspace|link|file):/.test(spec)) continue;
      const local = installedManifest(root, workspace, name);
      if (!local?.version) continue;
      const key = `${name}@${local.version}`;
      const known = installed.get(key);
      if (known) known.workspaces.push(workspace);
      else
        installed.set(key, {
          name,
          version: local.version,
          manifest: local,
          workspaces: [workspace],
        });
    }
  }
  const unsupported = new Map<string, UptideError>();
  for (const name of names) {
    try {
      validateVersionRanges(root, [name], read);
    } catch (error) {
      if (!(error instanceof UptideError) || error.code !== 'UNSUPPORTED_VERSION_RANGE')
        throw error;
      unsupported.set(name, error);
    }
  }
  if (!unsupported.size) return;
  const fetcher = createNpmFetcher({ config: loadRegistryConfig({ cwd: root }) });
  const pack = options.pack ?? activePack(options.only);
  const { version: target } = await resolveTarget(
    pack ?? { name: options.only, defaultTarget: '' },
    options.target,
    services?.resolve ?? fetcher.resolve,
  );
  const manifests = services?.manifests ?? fetcher.manifests;
  if (!manifests) throw new Error('Registry manifests are required to plan companions');
  const plan = await companionsOf({
    name: options.only,
    target,
    installed: [...installed.values()],
    manifests,
    lockstep: pack?.companions?.map((c) => c.name) ?? [],
  });
  for (const companion of plan.companions) {
    const error = unsupported.get(companion.name);
    if (error) throw error;
  }
  return target;
}
