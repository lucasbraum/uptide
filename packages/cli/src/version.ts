import { readFileSync } from 'node:fs';

/** The installed CLI manifest is authoritative, even if a tarball was versioned after build. */
export function cliVersion(manifestUrl: URL, stamp?: string): string {
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (manifest.name === 'uptide' && manifest.version) return manifest.version;
  } catch {
    // A standalone bundle can still identify itself using its build stamp.
  }
  if (stamp) return stamp;
  throw new Error('Cannot determine the installed Uptide CLI version');
}
declare const __UPTIDE_CLI_VERSION__: string | undefined;
export const VERSION = cliVersion(
  new URL('../package.json', import.meta.url),
  typeof __UPTIDE_CLI_VERSION__ === 'string' ? __UPTIDE_CLI_VERSION__ : undefined,
);
