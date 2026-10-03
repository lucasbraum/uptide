import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export interface RegistryConfig {
  /** Default registry, no trailing slash. */
  registry: string;
  /** `@scope` -> registry, no trailing slash. */
  scoped: Record<string, string>;
  /** `//host/path/` (as written in .npmrc, without the leading `//`) -> token. */
  tokens: Record<string, string>;
}

const stripSlash = (url: string): string => url.replace(/\/+$/, '');

/** Expands `${VAR}` the way npm does; unset variables become empty strings. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
}

export function parseNpmrc(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Partial<RegistryConfig> {
  const out: Partial<RegistryConfig> = { scoped: {}, tokens: {} };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = expandEnv(line.slice(eq + 1).trim(), env);
    if (key === 'registry') out.registry = stripSlash(value);
    else if (key.startsWith('@') && key.endsWith(':registry')) {
      (out.scoped as Record<string, string>)[key.slice(0, -':registry'.length)] = stripSlash(value);
    } else if (key.startsWith('//') && key.endsWith(':_authToken')) {
      (out.tokens as Record<string, string>)[key.slice(2, -':_authToken'.length)] = value;
    }
  }
  return out;
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Precedence follows npm: environment, then the project .npmrc, then the user .npmrc.
 * Only the keys the fetcher needs are read; everything else in the file is ignored.
 */
export function loadRegistryConfig(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RegistryConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const userFile = env.NPM_CONFIG_USERCONFIG ?? join(homedir(), '.npmrc');
  const layers = [
    parseNpmrc(readIfExists(userFile), env),
    parseNpmrc(readIfExists(join(cwd, '.npmrc')), env),
  ];
  const config: RegistryConfig = { registry: DEFAULT_REGISTRY, scoped: {}, tokens: {} };
  for (const layer of layers) {
    if (layer.registry) config.registry = layer.registry;
    Object.assign(config.scoped, layer.scoped);
    Object.assign(config.tokens, layer.tokens);
  }
  if (env.npm_config_registry) config.registry = stripSlash(env.npm_config_registry);
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('npm_config_@') && key.endsWith(':registry') && value) {
      config.scoped[key.slice('npm_config_'.length, -':registry'.length)] = stripSlash(value);
    }
  }
  return config;
}

export function registryFor(name: string, config: RegistryConfig): string {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  return (scope && config.scoped[scope]) || config.registry;
}

/** Token for a URL, matched the way npm does: by `//host/path/` prefix, longest first. */
export function tokenFor(url: string, config: RegistryConfig): string | undefined {
  const target = url.replace(/^https?:\/\//, '');
  const candidates = Object.keys(config.tokens)
    .filter((prefix) => target.startsWith(prefix))
    .sort((a, b) => b.length - a.length);
  const best = candidates[0];
  return best === undefined ? undefined : config.tokens[best];
}
