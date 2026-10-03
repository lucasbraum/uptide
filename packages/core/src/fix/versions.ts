import { assertManagerAvailable } from './managers/availability.js';
import { isolatedUpgrade } from './managers/isolated-install.js';
import type { InstallReport, Upgrade } from './managers/upgrade.js';

export { packageManager } from './managers/manager.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { UptideError } from '../errors.js';
import { command } from './process.js';

const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
/** Keep the manifest's chosen range operator; unusual ranges need an explicit policy. */
export function versionRange(before: string, version: string): string {
  const match = /^(\s*[~^]?\s*)(?:v)?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?\s*$/.exec(before);
  if (!match)
    throw new UptideError(
      'UNSUPPORTED_VERSION_RANGE',
      `Cannot preserve version range ${JSON.stringify(before)}; use an exact, ^ or ~ range before fixing.`,
    );
  return `${match[1]}${version}`;
}
/** Update catalog entries in place so comments and catalog names survive. */
export function bumpCatalog(yaml: string, name: string, version: string, catalog: string): string {
  const lines = yaml.split('\n');
  let top = '';
  let named = '';
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const header = /^([\w-]+):/.exec(line);
    if (header) {
      top = header[1] ?? '';
      named = '';
    }
    const sub = /^ {2}([\w-]+):\s*(?:#.*)?$/.exec(line);
    if (top === 'catalogs' && sub) named = sub[1] ?? '';
    const applies = catalog === '' ? top === 'catalog' : top === 'catalogs' && named === catalog;
    if (!applies) continue;
    const entry = /^(\s+)(?:'([^']+)'|"([^"]+)"|([^:#]+)):\s*([^#]*)(#.*)?$/.exec(line);
    if (!entry || (entry[2] ?? entry[3] ?? entry[4]?.trim()) !== name) continue;
    const keyEnd = line.indexOf(':', line.indexOf(name) + name.length);
    lines[i] =
      `${line.slice(0, keyEnd + 1)} ${versionRange((entry[5] ?? '').trim().replace(/^['"]|['"]$/g, ''), version)}${entry[6] ? ` ${entry[6]}` : ''}`;
    changed = true;
  }
  if (!changed) throw new Error(`catalog ${catalog || '(default)'} has no entry for ${name}`);
  return lines.join('\n');
}
export function bumpVersions(
  root: string,
  name: string,
  version: string,
): { files: string[]; workspaces: string[] } {
  const files: string[] = [];
  const workspaces: string[] = [];
  const catalogs = new Set<string>();
  for (const workspace of workspacePackagesOf(root)) {
    const file = join(root, workspace, 'package.json');
    const original = readFileSync(file, 'utf8');
    const json = JSON.parse(original);
    let declared = false;
    let changed = false;
    for (const section of sections) {
      const before = json[section]?.[name];
      if (typeof before !== 'string') continue;
      if (/^(workspace|link|file):/.test(before)) continue;
      declared = true;
      if (before.startsWith('catalog:')) catalogs.add(before.slice('catalog:'.length));
      else {
        json[section][name] = versionRange(before, version);
        changed = true;
      }
    }
    if (declared) workspaces.push(workspace);
    if (changed) {
      writeFileSync(
        file,
        `${JSON.stringify(json, null, original.match(/\n(\s+)"/)?.[1] ?? '  ')}\n`,
      );
      files.push(file);
    }
  }
  if (catalogs.size) {
    const file = join(root, 'pnpm-workspace.yaml');
    let text = readFileSync(file, 'utf8');
    for (const catalog of catalogs) text = bumpCatalog(text, name, version, catalog);
    writeFileSync(file, text);
    files.push(file);
  }
  if (!workspaces.length) throw new Error(`no workspace declares ${name}`);
  return { files, workspaces };
}
export async function install(root: string, upgrade?: Upgrade): Promise<InstallReport | undefined> {
  if (upgrade) return isolatedUpgrade(root, upgrade);
  const pm = await assertManagerAvailable(root);
  const result = await command(root, pm.bin, pm.args, 300_000, pm.env);
  if (result.code)
    throw new UptideError(
      'INSTALL_FAILED',
      `install failed${result.timeout ? ' (timeout)' : ''}: ${result.output}`,
    );
}
