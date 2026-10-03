import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.turbo']);

/**
 * Which of `names` a workspace's own sources import, by reading the files: `from 'pkg'`,
 * `require('pkg')`, `import('pkg')`, with or without a subpath. Only the workspace's own
 * directory counts, not nested workspaces: a package pulled into a program through another
 * workspace's files is that workspace's import, not this one's. Cheap enough to run for every
 * workspace in the main thread, which is what lets every workspace know who else imports.
 */
export function importedByText(
  root: string,
  workspace: string,
  names: readonly string[],
  nested: readonly string[] = [],
): string[] {
  if (names.length === 0) return [];
  const dir = resolve(root, workspace);
  const exclude = new Set(
    nested
      .filter((w) => w !== workspace)
      .map((w) => resolve(root, w))
      .filter((other) => other.startsWith(`${dir}/`)),
  );
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)["'](${escaped})(?:\\/[^"']*)?["']`,
    'g',
  );
  const found = new Set<string>();
  const walk = (at: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIPPED.has(name)) continue;
      const path = join(at, name);
      if (exclude.has(path)) continue;
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (directory) {
        walk(path);
        continue;
      }
      if (!SOURCE.test(name) || /\.d\.[cm]?ts$/.test(name)) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(pattern)) if (match[1]) found.add(match[1]);
      if (found.size === names.length) return;
    }
  };
  walk(dir);
  return [...found].sort();
}
