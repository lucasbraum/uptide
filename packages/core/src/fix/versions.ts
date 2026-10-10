import { assertManagerAvailable } from './managers/availability.js';
import { isolatedUpgrade } from './managers/isolated-install.js';
import type { InstallReport, Upgrade } from './managers/upgrade.js';

export { packageManager } from './managers/manager.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { compareVersions } from '../check/version.js';
import { UptideError } from '../errors.js';
import { installedManifest } from '../list/evidence.js';
import { command } from './process.js';

/** Check installed copies in every workspace before a plan can write manifests or install. */
export function assertNoDowngrades(
  root: string,
  moves: readonly { name: string; to: string }[],
): void {
  const rejected = new Set<string>();
  for (const workspace of workspacePackagesOf(root)) {
    for (const move of moves) {
      const from = installedManifest(root, workspace, move.name)?.version;
      if (from && compareVersions(move.to, from) < 0)
        rejected.add(`${move.name} ${from} → ${move.to} (${workspace})`);
    }
  }
  if (rejected.size)
    throw new UptideError(
      'INCONSISTENT_UPGRADE',
      `Refusing planned downgrades before install:\n${[...rejected].join('\n')}\nNothing was changed.`,
    );
}

const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
/** Keep the operator, precision and trailing wildcards, including simple npm aliases. */
export function versionRange(before: string, version: string): string {
  const alias = /^(npm:(?:@[^/\s]+\/)?[^@\s]+@)(.+)$/.exec(before);
  if (alias) return `${alias[1]}${versionRange(alias[2] as string, version)}`;
  const match = /^(\s*[~^]?\s*v?)(\d+(?:\.(?:\d+|[xX*])){0,2})(-[\w.-]+)?(\+[\w.-]+)?\s*$/.exec(
    before,
  );
  const parts = match?.[2]?.split('.');
  if (
    !match ||
    !parts ||
    ((match[3] || match[4]) && (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p)))) ||
    parts.some((p, i) => /[xX*]/.test(p) && parts.slice(i + 1).some((q) => /^\d+$/.test(q)))
  )
    throw new UptideError(
      'UNSUPPORTED_VERSION_RANGE',
      `Cannot preserve version range ${JSON.stringify(before)}; use an exact, ^ or ~ range before fixing.`,
    );
  const target = version.split('.');
  const full = parts.length === 3 && parts.every((p) => /^\d+$/.test(p));
  return `${match[1]}${full ? version : parts.map((p, i) => (/^[xX*]$/.test(p) ? p : target[i])).join('.')}`;
}

function declaredRange(
  before: string,
  version: string,
  file: string,
  field: string,
  name: string,
  installed: string | null | undefined,
): string {
  try {
    return versionRange(before, version);
  } catch (error) {
    if (!(error instanceof UptideError) || error.code !== 'UNSUPPORTED_VERSION_RANGE') throw error;
    const alias = /^(npm:(?:@[^/\s]+\/)?[^@\s]+@)/.exec(before)?.[1] ?? '';
    const suggestion = installed
      ? JSON.stringify(`${alias}^${installed}`)
      : 'an exact, ^ or ~ range matching the installed version';
    throw new UptideError(
      'UNSUPPORTED_VERSION_RANGE',
      `${file}: ${field} declares ${JSON.stringify(before)}, which cannot be rewritten safely. Change ${JSON.stringify(name)}: ${JSON.stringify(before)} in ${file} (${field}) to ${suggestion}, then rerun.`,
    );
  }
}

/** Update only the catalog scalar, preserving YAML comments and quoting. */
export function bumpCatalog(
  yaml: string,
  name: string,
  version: string,
  catalog: string,
  installed: string | null = version,
): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw doc.errors[0];
  const path = catalog ? ['catalogs', catalog, name] : ['catalog', name];
  const before = doc.getIn(path);
  if (typeof before !== 'string')
    throw new Error(`catalog ${catalog || '(default)'} has no entry for ${name}`);
  doc.setIn(
    path,
    declaredRange(before, version, 'pnpm-workspace.yaml', path.join('.'), name, installed),
  );
  return doc.toString();
}

/** The same rewrite as the writer, without touching files. `read` can read the committed ref. */
export function validateVersionRanges(
  root: string,
  names: readonly string[],
  read = (file: string) => readFileSync(join(root, file), 'utf8'),
): void {
  for (const workspace of workspacePackagesOf(root)) {
    const file = join(workspace, 'package.json');
    const json = JSON.parse(read(file));
    for (const name of names) {
      for (const section of sections) {
        const before = json[section]?.[name];
        if (typeof before !== 'string') continue;
        const installed = installedManifest(root, workspace, name)?.version;
        if (before.startsWith('catalog:'))
          bumpCatalog(
            read('pnpm-workspace.yaml'),
            name,
            installed ?? '0.0.0',
            before.slice(8),
            installed ?? null,
          );
        else
          declaredRange(before, installed ?? '0.0.0', file, `${section}.${name}`, name, installed);
      }
    }
  }
}
export function bumpVersions(
  root: string,
  name: string,
  version: string,
): { files: string[]; workspaces: string[] } {
  validateVersionRanges(root, [name]);
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
      declared = true;
      if (before.startsWith('catalog:')) catalogs.add(before.slice('catalog:'.length));
      else {
        json[section][name] = declaredRange(
          before,
          version,
          relative(root, file),
          `${section}.${name}`,
          name,
          installedManifest(root, workspace, name)?.version ?? version,
        );
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
