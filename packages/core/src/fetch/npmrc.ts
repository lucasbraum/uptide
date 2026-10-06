import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'ini';
import { workspacePackagesOrRoot } from '../workspaces.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export interface RegistryConfig {
  registry: string;
  scoped: Record<string, string>;
  /** Host/path-scoped credentials stay in memory, never in reports or cache keys. */
  tokens: Record<string, string>;
  basicAuth?: Record<string, string>;
}
const stripSlash = (url: string): string => url.replace(/\/+$/, '');

function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (match, escapes: string, name: string, optional: string) => {
      if (escapes.length % 2) return match.slice((escapes.length + 1) / 2);
      return escapes.slice(escapes.length / 2) + (env[name] ?? (optional ? '' : `\${${name}}`));
    },
  );
}

function registryConfig(values: Record<string, unknown>): Partial<RegistryConfig> {
  const out: Partial<RegistryConfig> = { scoped: {}, tokens: {} };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') continue;
    if (key === 'registry') out.registry = stripSlash(value);
    else if (key.startsWith('@') && key.endsWith(':registry'))
      (out.scoped as Record<string, string>)[key.slice(0, -':registry'.length)] = stripSlash(value);
    else if (key.startsWith('//')) {
      const match = key.match(/^(\/\/.*):(_authToken|_auth|username|_password)$/);
      if (!match) continue;
      const [, scope, field] = match as [string, string, string];
      const prefix = `${stripSlash(scope.slice(2))}/`;
      if (field === '_authToken') (out.tokens as Record<string, string>)[prefix] = value;
      if (field === '_auth') {
        out.basicAuth ??= {};
        out.basicAuth[prefix] = value;
      }
      if (field === 'username' && typeof values[`${scope}:_password`] === 'string') {
        out.basicAuth ??= {};
        out.basicAuth[prefix] = Buffer.from(
          `${value}:${Buffer.from(values[`${scope}:_password`] as string, 'base64').toString('utf8')}`,
        ).toString('base64');
      }
    }
  }
  return out;
}
const fields = (text: string, env: NodeJS.ProcessEnv): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(parse(text)).map(([key, value]) => [
      key,
      typeof value === 'string' ? expandEnv(value, env) : value,
    ]),
  );

export function parseNpmrc(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Partial<RegistryConfig> {
  return registryConfig(fields(text, env));
}
function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function projectRoot(cwd: string): string {
  let nearest: string | undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      nearest ??= dir;
      try {
        if (
          JSON.parse(readIfExists(join(dir, 'package.json'))).workspaces &&
          workspacePackagesOrRoot(dir).includes(relative(dir, nearest).replaceAll('\\', '/') || '.')
        )
          return dir;
      } catch {
        /* not a manifest */
      }
    }
    if (
      existsSync(join(dir, 'pnpm-workspace.yaml')) &&
      (!nearest ||
        workspacePackagesOrRoot(dir).includes(relative(dir, nearest).replaceAll('\\', '/') || '.'))
    )
      return dir;
    if (dirname(dir) === dir) return nearest ?? cwd;
  }
}

/** npm's INI parser and precedence: environment > project > user > global. */
export function loadRegistryConfig(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RegistryConfig {
  const env = opts.env ?? process.env;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(key) || value === undefined) continue;
    const raw = key.slice('npm_config_'.length);
    // npm preserves host-scoped keys, including the case-sensitive _authToken suffix.
    environment[raw.startsWith('//') ? raw : raw.toLowerCase().replaceAll('_', '-')] = expandEnv(
      value,
      env,
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  const home = env.HOME ?? homedir();
  const pathOf = (value: string): string => resolve(cwd, value.replace(/^~(?=\/|$)/, home));
  const project = fields(readIfExists(join(projectRoot(cwd), '.npmrc')), env);
  const userFile = String(environment.userconfig ?? project.userconfig ?? join(home, '.npmrc'));
  const user = fields(readIfExists(pathOf(userFile)), env);
  const prefix = String(
    environment.prefix ??
      project.prefix ??
      user.prefix ??
      env.PREFIX ??
      dirname(dirname(process.execPath)),
  );
  const globalFile = String(
    environment.globalconfig ??
      project.globalconfig ??
      user.globalconfig ??
      join(prefix, 'etc/npmrc'),
  );
  return {
    registry: DEFAULT_REGISTRY,
    scoped: {},
    tokens: {},
    ...registryConfig({
      ...fields(readIfExists(pathOf(globalFile)), env),
      ...user,
      ...project,
      ...environment,
    }),
  };
}
export function registryFor(name: string, config: RegistryConfig): string {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  return (scope && config.scoped[scope]) || config.registry;
}
function scopedCredential(url: string, credentials: Record<string, string>): string | undefined {
  const target = new URL(url);
  const candidates = Object.keys(credentials)
    .filter((prefix) => {
      try {
        const scope = new URL(`https://${prefix}`);
        return (
          scope.host === target.host &&
          target.pathname.startsWith(
            scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`,
          )
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.length - a.length);
  return candidates[0] === undefined ? undefined : credentials[candidates[0]];
}
export function tokenFor(url: string, config: RegistryConfig): string | undefined {
  return scopedCredential(url, config.tokens);
}
export function authHeaders(url: string, config: RegistryConfig): Record<string, string> {
  const credentials = {
    ...Object.fromEntries(
      Object.entries(config.basicAuth ?? {})
        .filter(([, value]) => value)
        .map(([key, value]) => [key, `Basic ${value}`]),
    ),
    ...Object.fromEntries(
      Object.entries(config.tokens)
        .filter(([, value]) => value)
        .map(([key, value]) => [key, `Bearer ${value}`]),
    ),
  };
  const authorization = scopedCredential(url, credentials);
  return authorization ? { authorization } : {};
}
