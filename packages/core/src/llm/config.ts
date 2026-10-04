import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_MODELS } from './pricing.js';
import { PROVIDERS, type Provider } from './types.js';

export const KEY_ENV: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
export const ACCEPTED_KEYS = Object.values(KEY_ENV).join(', ');
export interface Selection {
  provider: Provider;
  model: string;
  available: boolean;
  baseUrl?: string;
}
const keyLike = (s: string) =>
  /(?:sk-[\w-]{8,}|AIza[\w-]{12,}|phc_[\w-]+|bearer\s|api[_-]?key|secret|password|access[_-]?token)/i.test(
    s,
  );
export function validModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    !keyLike(value) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) &&
    !value.split('/').some((p) => p === '.' || p === '..' || !p)
  );
}
function readConfig(cwd: string): { provider?: string; model?: string } {
  // Nearest config up to the Git root; includes a root config when invoked in a workspace.
  let dir = resolve(cwd);
  for (;;) {
    const path = join(dir, 'uptide.config.json');
    if (existsSync(path)) {
      let value: unknown;
      let keyFound = false;
      try {
        if (statSync(path).size > 4096) throw new Error();
        const raw = readFileSync(path, 'utf8');
        // Inspect every JSON string, including overwritten duplicate fields and escaped keys.
        // JSON.parse alone would discard an earlier credential with the same field name.
        keyFound = [...raw.matchAll(/"(?:\\.|[^"\\])*"/g)].some((match) =>
          keyLike(JSON.parse(match[0])),
        );
        value = JSON.parse(raw);
      } catch {
        throw new Error(
          'uptide.config.json must be a small valid JSON object containing only provider and model. Keys belong only in environment variables.',
        );
      }
      if (keyFound)
        throw new Error(
          'uptide.config.json contains a key-like setting. Remove credentials from the file; use environment variables only.',
        );
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(
          'uptide.config.json must contain only provider and model; API keys belong only in environment variables.',
        );
      for (const [name, setting] of Object.entries(value)) {
        if (keyLike(name) || (typeof setting === 'string' && keyLike(setting)))
          throw new Error(
            'uptide.config.json contains a key-like setting. Remove credentials from the file; use environment variables only.',
          );
        if (!['provider', 'model'].includes(name) || typeof setting !== 'string')
          throw new Error(
            'uptide.config.json accepts only provider and model strings. Keys belong only in environment variables.',
          );
      }
      const config = value as { provider?: string; model?: string };
      if (config.provider !== undefined && !PROVIDERS.includes(config.provider as Provider))
        throw new Error(
          'Invalid provider in uptide.config.json: choose anthropic, openai or gemini.',
        );
      if (config.model !== undefined && !validModel(config.model))
        throw new Error(
          'Invalid model in uptide.config.json: expected a model ID, never a key, URL or path.',
        );
      return config;
    }
    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, '.git'))) return {};
    dir = parent;
  }
}
export function openaiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'OPENAI_BASE_URL must be an HTTPS API base URL (HTTP is allowed only on localhost).',
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'OPENAI_BASE_URL must use HTTPS without credentials, query or fragment (HTTP is allowed only on localhost).',
    );
  return url.href.replace(/\/+$/, '');
}
export function selectLlm(
  cwd: string,
  flags: { provider?: string; model?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Selection {
  const config = readConfig(cwd); // Validate even when flags override it; never tolerate stored keys.
  const provider =
    flags.provider ??
    env.UPTIDE_PROVIDER ??
    config.provider ??
    PROVIDERS.find((p) => !!env[KEY_ENV[p]]?.trim()) ??
    'anthropic';
  if (!PROVIDERS.includes(provider as Provider))
    throw new Error('Invalid LLM provider: choose anthropic, openai or gemini.');
  const chosen = provider as Provider;
  const model = flags.model ?? env.UPTIDE_MODEL ?? config.model ?? DEFAULT_MODELS[chosen];
  if (!validModel(model))
    throw new Error('Invalid LLM model: expected a model ID, never a key, URL or path.');
  return {
    provider: chosen,
    model,
    available: !!env[KEY_ENV[chosen]]?.trim(),
    ...(chosen === 'openai' && env.OPENAI_BASE_URL
      ? { baseUrl: openaiBaseUrl(env.OPENAI_BASE_URL) }
      : {}),
  };
}
