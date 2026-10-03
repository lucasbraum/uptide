import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface Excerpt {
  lines: { number: number; text: string }[];
  unavailable?: string;
}
export type ReadExcerpt = (file: string, line: number) => Excerpt;
export function localFile(root: string, file: string): string | undefined {
  if (isAbsolute(file)) return undefined;
  const absolute = resolve(root, file);
  const rel = relative(resolve(root), absolute);
  return rel === '..' || rel.startsWith(`..${sep}`) ? undefined : absolute;
}
/** Only reported, repo-contained regular files; symlinks must stay inside the repo too. */
export function excerptReader(root: string): ReadExcerpt {
  return (file, line) => {
    let fd: number | undefined;
    try {
      if (!Number.isSafeInteger(line) || line < 1) throw new Error('invalid line');
      const candidate = localFile(root, file);
      if (!candidate) throw new Error('outside repository');
      const realRoot = realpathSync(root),
        realFile = realpathSync(candidate);
      if (!localFile(realRoot, relative(realRoot, realFile))) throw new Error('outside repository');
      fd = openSync(realFile, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new Error('not a small regular file');
      const lines = readFileSync(fd, 'utf8').split(/\r?\n/);
      if (line > lines.length) throw new Error('line unavailable');
      return {
        lines: lines.slice(Math.max(0, line - 4), line + 3).map((text, i) => ({
          number: Math.max(1, line - 3) + i,
          text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
        })),
      };
    } catch {
      return {
        lines: [],
        unavailable: 'Excerpt unavailable (missing, outside repository, or file too large).',
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}
