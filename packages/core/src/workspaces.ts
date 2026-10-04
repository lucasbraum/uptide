import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Workspace packages declared by pnpm-workspace.yaml (`packages:` list) or package.json
 * `workspaces`, expanded one directory level for `dir/*` patterns, honoring `!` exclusions.
 * The root is a workspace too. Directories without a package.json are not packages.
 */
export function workspacePackagesOf(root: string): string[] {
  const patterns: string[] = [];
  const yaml = join(root, 'pnpm-workspace.yaml');
  if (existsSync(yaml)) {
    // Minimal YAML: only the `packages:` block list is read; the rest (catalog, overrides) is irrelevant here.
    let inPackages = false;
    for (const line of readFileSync(yaml, 'utf8').split('\n')) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\s+-\s*/.test(line)) {
        patterns.push(
          line
            .replace(/^\s+-\s*/, '')
            .trim()
            .replace(/^['"]|['"]$/g, ''),
        );
        continue;
      }
      if (inPackages && !/^\s/.test(line) && line.trim() !== '') inPackages = false;
    }
  } else {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        workspaces?: string[] | { packages?: string[] };
      };
      patterns.push(
        ...(Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? [])),
      );
    } catch {
      // no package.json: no workspaces
    }
  }
  const excluded = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => p.slice(1).replace(/\/\*\*?$/, ''));
  const found = new Set<string>(['.']);
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const clean = pattern.replace(/^\.\//, '').replace(/\/\*\*?$/, '/*');
    if (clean.endsWith('/*')) {
      const parentRel = clean.slice(0, -2);
      const parent = join(root, parentRel);
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json')))
          found.add(`${parentRel}/${entry.name}`);
      }
    } else if (existsSync(join(root, clean, 'package.json'))) {
      found.add(clean);
    }
  }
  return [...found].filter((d) => !excluded.some((e) => d === e || d.startsWith(`${e}/`))).sort();
}
