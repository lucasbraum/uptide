import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CheckReport } from '@uptide/core';
import { excerptReader } from './excerpts.js';
import { type HtmlOptions, renderHtml } from './render.js';

export function writeHtml(
  report: CheckReport,
  opts: HtmlOptions,
  path: string | true,
  cwd: string,
): string {
  const slug =
    (opts.header?.repo ?? basename(opts.root)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) ||
    'repo';
  const target =
    typeof path === 'string'
      ? resolve(cwd, path)
      : join(tmpdir(), 'uptide', `${slug}-${Date.now()}.html`);
  const html = renderHtml(report, {
    ...opts,
    readExcerpt: opts.readExcerpt ?? excerptReader(opts.root),
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, { mode: 0o600, flag: typeof path === 'string' ? 'w' : 'wx' });
  return target;
}
/** No shell on macOS/Linux; Windows start rejects shell metacharacters in the path. */
export function browserCommand(path: string, platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [path]];
  if (platform === 'win32') {
    // cmd expands percent signs even inside quotes; reject rather than execute a user path as shell text.
    if (/["%&|<>^!\r\n]/.test(path))
      throw new Error('Open this report manually: its path contains Windows shell metacharacters.');
    return ['cmd.exe', ['/d', '/s', '/c', 'start', '""', `"${path}"`]];
  }
  return ['xdg-open', [path]];
}
export async function openHtml(path: string): Promise<void> {
  const [bin, args] = browserCommand(path);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'ignore',
      windowsVerbatimArguments: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)),
    );
  });
}
