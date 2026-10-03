import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __UPTIDE_BUILD_VERSION__: string;
export const version: string =
  typeof __UPTIDE_BUILD_VERSION__ !== 'undefined'
    ? __UPTIDE_BUILD_VERSION__
    : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
declare const __UPTIDE_BUILD_COMMIT__: string;
declare const __UPTIDE_BUILD_DIRTY__: boolean;

/**
 * What `git status --porcelain` reports, minus the bundler's own scratch file: tsup writes
 * `tsup.config.bundled_<id>.mjs` next to the config while it loads it, which is exactly when
 * the build asks whether the tree is clean. Counting it made every build "dirty".
 */
export function dirtyLines(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => !/(?:^|\/)tsup\.config\.bundled_[\w-]+\.[cm]?js$/.test(line.slice(3)));
}

/**
 * The dirty-tree guard is about reproducing a run from Uptide's source: it applies to a
 * source checkout (development, the eval scripts), never to a published build. A release
 * builds after `changeset version` wrote the new version into the tree, so CI stamps that
 * build clean by saying so (`UPTIDE_BUILD_CLEAN=1`) and fails if the stamp is dirty anyway.
 */
export function uptideVersionInfo(env: NodeJS.ProcessEnv = process.env): {
  uptideVersion: string;
  uptideCommit: string;
  uptideDirty: boolean;
} {
  if (typeof __UPTIDE_BUILD_COMMIT__ !== 'undefined')
    return {
      uptideVersion: version,
      uptideCommit: __UPTIDE_BUILD_COMMIT__,
      uptideDirty: __UPTIDE_BUILD_DIRTY__,
    };
  const clean = env.UPTIDE_BUILD_CLEAN === '1';
  // Source execution resolves the tool's checkout, never the consumer's working directory.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'uptide-monorepo')
      throw new Error('not the Uptide source checkout');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    return {
      uptideVersion: version,
      uptideCommit: git('rev-parse', 'HEAD'),
      uptideDirty:
        !clean && dirtyLines(git('status', '--porcelain', '--untracked-files=all')).length > 0,
    };
  } catch {
    return { uptideVersion: version, uptideCommit: 'unknown', uptideDirty: false };
  }
}

declare const __UPTIDE_CLI_VERSION__: string | undefined;

/**
 * How a reader runs the build that is talking to them: `npx uptide` when it is a stable
 * version (what the `latest` dist-tag serves), `npx uptide@next` when it is a prerelease
 * such as `0.3.0-next.20261003`, named after its own dist-tag. A command printed by a
 * `next` build must not send the reader to another build.
 */
export function uptideCommand(cliVersion: string): string {
  const tag = /^\d+\.\d+\.\d+-([a-z]+)/.exec(cliVersion)?.[1];
  return tag ? `npx uptide@${tag}` : 'npx uptide';
}

/**
 * The command for anything written for a reader (PR descriptions, reports). The CLI bundle
 * defines its own published version; the engine's version never carries a dist-tag.
 */
export const UPTIDE_COMMAND = uptideCommand(
  typeof __UPTIDE_CLI_VERSION__ === 'string' ? __UPTIDE_CLI_VERSION__ : version,
);
