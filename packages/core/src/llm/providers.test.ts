import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { FixRequest } from '../fix/types.js';
import { adapters } from './adapters.js';
import { KEY_ENV, openaiBaseUrl, selectLlm } from './config.js';
import { CostLimitError, estimateInputTokens, providerFixer } from './fixer.js';
import { DEFAULT_MODELS, priceFor, reserveCost, usageCost } from './pricing.js';
import { PROVIDERS } from './types.js';

const root = mkdtempSync(join(tmpdir(), 'uptide-provider-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = {
  finding: { change: { package: 'zod' }, usage: { snippet: 'z.string()', file: 'src/a.ts' } },
  guide: 'Migration guide',
  source: 'UNRELATED_PRIVATE_SOURCE',
  enclosingFunction: 'function parse() { return z.string(); }',
  compilerError: 'TS2322',
} as FixRequest;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value');
  return value;
}
const recorded = (provider: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${provider}.json`, import.meta.url), 'utf8'));
for (const provider of PROVIDERS) {
  it(`${provider}: replays wire response, scoped context, forced tool, usage and authentication`, async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(recorded(provider))));
    const model = DEFAULT_MODELS[provider];
    const fixer = required(
      providerFixer(
        { provider, model, available: true },
        { env: { [KEY_ENV[provider]]: 'test-only' }, fetch: fetcher },
      ),
    );
    const reply = await fixer?.fix(request);
    expect(reply?.diff).toContain('+++ b/src/a.ts');
    expect(reply?.failure).toBeUndefined();
    expect(reply?.inputTokens).toBe(100);
    expect(reply?.outputTokens).toBe(20);
    const normalized = required(adapters[provider].parse(recorded(provider)).usage);
    expect(reply?.costUsd).toBe(usageCost(provider, model, normalized));
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('test-only');
    expect(JSON.stringify(options.headers)).toContain('test-only');
    expect(options.redirect).toBe('error');
    const body = JSON.parse(String(options.body));
    expect(String(options.body)).not.toContain('UNRELATED_PRIVATE_SOURCE');
    expect(String(options.body)).toContain('function parse()');
    if (provider === 'openai') {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(body.tool_choice).toEqual({ type: 'function', name: 'submit_patch' });
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.tools[0].strict).toBe(true);
      expect(body.store).toBe(false);
    } else if (provider === 'gemini') {
      expect(body.toolConfig.functionCallingConfig).toEqual({
        mode: 'ANY',
        allowedFunctionNames: ['submit_patch'],
      });
    } else expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_patch' });
    expect(providerFixer({ provider, model, available: false }, { env: {} })).toBeUndefined();
  });
  it(`${provider}: rejects text-only, malformed and multiple tools as paid failed attempts`, async () => {
    const original = recorded(provider);
    const missing = structuredClone(original);
    if (provider === 'anthropic') missing.content = [{ type: 'text', text: 'pretend patch' }];
    if (provider === 'openai') missing.output = [{ type: 'message', content: 'pretend patch' }];
    if (provider === 'gemini') missing.candidates[0].content.parts = [{ text: 'pretend patch' }];
    const invalid = structuredClone(original);
    if (provider === 'anthropic') invalid.content[0].input = { diff: 42 };
    if (provider === 'openai') invalid.output[0].arguments = '{bad json';
    if (provider === 'gemini') invalid.candidates[0].content.parts[0].functionCall.name = 'other';
    const multiple = structuredClone(original);
    if (provider === 'anthropic') multiple.content.push(multiple.content[0]);
    if (provider === 'openai') multiple.output.push(multiple.output[0]);
    if (provider === 'gemini')
      multiple.candidates[0].content.parts.push(multiple.candidates[0].content.parts[0]);
    for (const response of [missing, invalid, multiple]) {
      const fixer = required(
        providerFixer(
          { provider, model: DEFAULT_MODELS[provider], available: true },
          {
            env: { [KEY_ENV[provider]]: 'test-only' },
            fetch: async () => new Response(JSON.stringify(response)),
          },
        ),
      );
      const reply = await fixer?.fix(request);
      expect(reply?.failure).toContain('Missing or invalid submit_patch');
      expect(reply?.diff).toBe('');
      expect(reply?.costUsd).toBeGreaterThan(0);
    }
  });
  it(`${provider}: refuses a call before HTTP if its full reservation will not fit`, async () => {
    const fetcher = vi.fn();
    const fixer = required(
      providerFixer(
        { provider, model: DEFAULT_MODELS[provider], available: true },
        { env: { [KEY_ENV[provider]]: 'test-only' }, fetch: fetcher },
      ),
    );
    const estimate = required(fixer.estimate)(request);
    expect(estimate).toBeGreaterThan(0);
    await expect(fixer.fix(request, estimate - 0.000001)).rejects.toBeInstanceOf(CostLimitError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(required(fixer.estimate)({ ...request, retry: 'x'.repeat(10000) })).toBeGreaterThan(
      estimate,
    );
  });
}
it('reserves uncertain charges on HTTP errors, timeouts, invalid JSON and missing usage', async () => {
  const responses: (typeof fetch)[] = [
    async () => new Response('PRIVATE_API_ERROR', { status: 429 }),
    async () => {
      throw new Error('PRIVATE_KEY_AND_URL');
    },
    async () => new Response('invalid json'),
    async () => new Response('{}'),
  ];
  for (const fetcher of responses) {
    const fixer = required(
      providerFixer(
        { provider: 'openai', model: DEFAULT_MODELS.openai, available: true },
        { env: { OPENAI_API_KEY: 'test-only' }, fetch: fetcher },
      ),
    );
    const result = await fixer.fix(request);
    expect(result.unreportedCostUsd).toBe(required(fixer.estimate)(request));
    expect(result.costUsd).toBe(0);
    expect(result.failure).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  }
});
it('accounts for cache writes/reads and reasoning without double counting', () => {
  const anthropic = required(
    adapters.anthropic.parse({
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_1h_input_tokens: 15 },
      },
    }).usage,
  );
  expect(anthropic).toEqual({
    inputTokens: 60,
    outputTokens: 20,
    cachedInputTokens: 10,
    cacheWriteTokens: 25,
    cacheWriteHourTokens: 15,
  });
  expect(usageCost('anthropic', 'claude-sonnet-4-6', anthropic)).toBeCloseTo(
    (50 * 3 + 10 * 0.3 + 25 * 3.75 + 15 * 6 + 20 * 15) / 1e6,
    8,
  );
  expect(adapters.openai.parse(recorded('openai')).usage?.outputTokens).toBe(20);
  expect(adapters.gemini.parse(recorded('gemini')).usage?.outputTokens).toBe(20);
  expect(
    adapters.openai.parse({ usage: { input_tokens: 10, output_tokens: -1 } }).usage,
  ).toBeUndefined();
});
it('uses long-context prices, dated Gemini prices and conservative unknown-model prices', () => {
  expect(priceFor('openai', DEFAULT_MODELS.openai, 272001).input).toBe(4);
  expect(priceFor('gemini', DEFAULT_MODELS.gemini, 0, '2026-12-31').output).toBe(3.75);
  expect(priceFor('gemini', DEFAULT_MODELS.gemini, 0, '2027-01-01').output).toBe(7.5);
  expect(priceFor('openai', 'constructor').fallback).toBe(true);
  expect(priceFor('openai', 'custom')).toMatchObject({ input: 20, output: 120, fallback: true });
  expect(priceFor('gemini', 'custom')).toMatchObject({ input: 4, output: 18, fallback: true });
  expect(reserveCost('openai', 'custom', 1000, 1000)).toBe(0.145);
  expect(estimateInputTokens({ url: '', body: { input: 'é' }, maxTokens: 1 })).toBeGreaterThan(
    8192 + JSON.stringify({ input: 'é' }).length,
  );
});
it('resolves flags > environment > nearest repo config > ordered key detection', () => {
  const dir = mkdtempSync(join(root, 'config-'));
  mkdirSync(join(dir, '.git'));
  const env = { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', GEMINI_API_KEY: 'test' };
  expect(selectLlm(dir, {}, env).provider).toBe('anthropic');
  expect(selectLlm(dir, {}, { OPENAI_API_KEY: 'test', GEMINI_API_KEY: 'test' }).provider).toBe(
    'openai',
  );
  expect(selectLlm(dir, {}, { GEMINI_API_KEY: 'test' }).provider).toBe('gemini');
  expect(selectLlm(dir, {}, {})).toMatchObject({ provider: 'anthropic', available: false });
  writeFileSync(
    join(dir, 'uptide.config.json'),
    JSON.stringify({ provider: 'gemini', model: 'config-model' }),
  );
  mkdirSync(join(dir, 'child'));
  expect(selectLlm(join(dir, 'child'), {}, env)).toMatchObject({
    provider: 'gemini',
    model: 'config-model',
  });
  expect(
    selectLlm(dir, {}, { ...env, UPTIDE_PROVIDER: 'openai', UPTIDE_MODEL: 'env-model' }),
  ).toMatchObject({ provider: 'openai', model: 'env-model' });
  expect(
    selectLlm(
      dir,
      { provider: 'anthropic', model: 'flag-model' },
      { ...env, UPTIDE_PROVIDER: 'openai', UPTIDE_MODEL: 'env-model' },
    ),
  ).toMatchObject({ provider: 'anthropic', model: 'flag-model' });
  expect(selectLlm(dir, { provider: 'openai' }, { GEMINI_API_KEY: 'test' }).available).toBe(false);
});
it('rejects stored keys, unknown fields, nested credentials and malformed config even if overridden', () => {
  const dir = mkdtempSync(join(root, 'unsafe-'));
  for (const config of [
    { apiKey: 'PRIVATE_CREDENTIAL' },
    { model: 'sk-PRIVATE_CREDENTIAL' },
    { model: 'AIzaPRIVATE_CREDENTIAL' },
    { model: '../private/path' },
    { provider: 'https://private.test' },
    { credentials: { token: 'PRIVATE_CREDENTIAL' } },
    [],
    null,
  ]) {
    writeFileSync(join(dir, 'uptide.config.json'), JSON.stringify(config));
    expect(() => selectLlm(dir, { provider: 'openai', model: DEFAULT_MODELS.openai }, {})).toThrow(
      /uptide.config.json/,
    );
    try {
      selectLlm(dir, {}, {});
    } catch (e) {
      expect(String(e)).not.toContain('PRIVATE_CREDENTIAL');
    }
  }
});
it('supports Responses-compatible HTTPS endpoints and local HTTP, never URL credentials or redirects', () => {
  expect(openaiBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
  expect(adapters.openai.prepare('custom', [], 8192, 'https://example.test/v1').url).toBe(
    'https://example.test/v1/responses',
  );
  for (const url of [
    'http://example.test',
    'https://user:password@example.test',
    'https://example.test?key=secret',
    'file:///tmp/file',
  ])
    expect(() => openaiBaseUrl(url)).toThrow();
});

it('stops when returned token usage breaks the reservation contract', async () => {
  const response = recorded('openai');
  response.usage.output_tokens = 9000;
  const fixer = required(
    providerFixer(
      { provider: 'openai', model: DEFAULT_MODELS.openai, available: true },
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: async () => new Response(JSON.stringify(response)),
      },
    ),
  );
  const result = await fixer.fix(request);
  expect(result.halt).toBe(true);
  expect(result.diff).toBe('');
  expect(result.outputTokens).toBe(9000);
});
