import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface Manifest {
  [key: string]: unknown;
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function installedManifest(
  root: string,
  workspace: string,
  name: string,
): Manifest | undefined {
  for (let dir = resolve(root, workspace); ; dir = dirname(dir)) {
    try {
      return JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
    } catch {
      // Discovery also works before installation; registry metadata supplies peers and bins.
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export const isConfig = (file: string): boolean =>
  /(?:^|\/)(?:tsconfig[^/]*\.jsonc?|nest-cli\.json|\.(?:eslintrc|prettierrc|babelrc|commitlintrc|czrc|cz-config)(?:\.[^/]+)?|[^/]*\.config\.[^/]+|(?:karma\.conf|gulpfile|jest|eslint|prettier|webpack|commitlint|cz)[^/]*\.(?:json|[cm]?[jt]s))$/.test(
    file,
  ) || /(?:^|\/)\.husky\//.test(file);

export const knownTool = (name: string): boolean =>
  /^(?:eslint|prettier)/.test(name) ||
  /^(?:@eslint\/|@typescript-eslint\/|@jest\/|@prettier\/)/.test(name) ||
  [
    'jest',
    'ts-jest',
    'typescript',
    'webpack',
    'ts-loader',
    '@nestjs/cli',
    '@nestjs/schematics',
  ].includes(name);

/** Match whole package/bin tokens, including subpaths, without matching e.g. foo in foo-bar. */
export function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w@/.-])${escaped}(?=$|[^\\w.-])`).test(text);
}

export function toolingReasons(
  name: string,
  metadata: Manifest[],
  scripts: string,
  configs: string,
  manifests: Manifest[] = [],
): string[] {
  const reasons: string[] = [];
  if (knownTool(name)) reasons.push('known configuration or build tool');
  const bins = metadata.flatMap((m) =>
    typeof m.bin === 'string' ? [name.split('/').at(-1) as string] : Object.keys(m.bin ?? {}),
  );
  if (
    [name, ...bins].some((token) => mentions(scripts, token)) ||
    scripts.split(/[\s;&|\x22\x27`]+/).some((token) => bins.includes(basename(token))) ||
    scripts.includes(`node_modules/${name}/`)
  )
    reasons.push('used by package scripts');
  if (referencesPackage(configs, name) || bins.some((bin) => mentions(configs, bin)))
    reasons.push('referenced by configuration');
  for (const manifest of manifests) {
    for (const [field, consumers] of Object.entries(CONFIG_FIELDS)) {
      const value =
        field === 'config.commitizen'
          ? (manifest.config as { commitizen?: unknown } | undefined)?.commitizen
          : manifest[field];
      if (value === undefined) continue;
      const text = JSON.stringify(value);
      if (
        consumers.includes(name) ||
        referencesPackage(text, name) ||
        bins.some((bin) => mentions(text, bin))
      )
        reasons.push(`package.json field: ${field}`);
    }
  }
  return [...new Set(reasons)];
}

const CONFIG_FIELDS: Record<string, string[]> = {
  husky: ['husky'],
  'lint-staged': ['lint-staged'],
  'config.commitizen': ['commitizen'],
  prettier: ['prettier'],
  eslintConfig: ['eslint'],
  babel: ['@babel/core', 'babel-core'],
  jest: ['jest'],
  browserslist: ['browserslist'],
  stylelint: ['stylelint'],
};
function referencesPackage(text: string, name: string): boolean {
  return mentions(text, name) || mentions(text.replace(/(?:\.\.?\/)*node_modules\//g, ''), name);
}
export const UNUSED_REASON =
  'no static imports, script/bin usage, configuration references, stylesheet imports or HTML assets found';
