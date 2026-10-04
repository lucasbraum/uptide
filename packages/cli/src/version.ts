import { readFileSync } from 'node:fs';

declare const __UPTIDE_CLI_VERSION__: string | undefined;

// tsup embeds the CLI manifest version into every build. The fallback supports running
// TypeScript directly in development/tests, where the build-time define is absent.
export const VERSION: string =
  typeof __UPTIDE_CLI_VERSION__ === 'string'
    ? __UPTIDE_CLI_VERSION__
    : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
