import type { Fixer, FixRequest, FixResponse } from '../fix/types.js';
import { adapters } from './adapters.js';
import { KEY_ENV, type Selection } from './config.js';
import { nanos, reserveCost, usageCost } from './pricing.js';
import { messages } from './prompt.js';
import type { Call } from './types.js';

export const MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_MAX_COST_USD = 1;
// One token per UTF-8 byte, including JSON, schema, system prompt and retry feedback,
// plus 8192 tokens for provider framing/tool overhead. Deliberately NOT chars / 4.
export const estimateInputTokens = (call: Call): number =>
  Buffer.byteLength(JSON.stringify(call.body), 'utf8') + 8192;
export class CostLimitError extends Error {
  constructor(readonly requiredUsd: number) {
    super(
      `Next LLM call requires a worst-case reservation of $${requiredUsd.toFixed(6)}; insufficient --max-cost budget.`,
    );
  }
}
export function providerFixer(
  selection: Selection,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): Fixer | undefined {
  const key = (options.env ?? process.env)[KEY_ENV[selection.provider]];
  if (!key?.trim()) return undefined;
  const adapter = adapters[selection.provider],
    fetcher = options.fetch ?? fetch;
  const prepare = (request: FixRequest) =>
    adapter.prepare(selection.model, messages(request), MAX_OUTPUT_TOKENS, selection.baseUrl);
  const estimate = (request: FixRequest) => {
    const call = prepare(request);
    return reserveCost(
      selection.provider,
      selection.model,
      estimateInputTokens(call),
      call.maxTokens,
    );
  };
  return {
    id: selection.model,
    provider: selection.provider,
    estimate,
    async fix(request, remainingUsd = DEFAULT_MAX_COST_USD) {
      const prepared = prepare(request),
        inputBound = estimateInputTokens(prepared);
      const reserved = reserveCost(
        selection.provider,
        selection.model,
        inputBound,
        prepared.maxTokens,
      );
      if (!Number.isFinite(remainingUsd) || nanos(reserved) > Math.floor(remainingUsd * 1e9))
        throw new CostLimitError(reserved);
      const unknown = (failure: string): FixResponse => ({
        diff: '',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unreportedCostUsd: reserved,
        failure,
      });
      let body: unknown;
      try {
        const res = await fetcher(prepared.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
          headers: { 'content-type': 'application/json', ...adapter.headers(key) },
          body: JSON.stringify(prepared.body),
        });
        // Never echo URLs, API error bodies, request headers or provider-controlled text.
        if (!res.ok)
          return unknown(
            `${selection.provider} request failed (HTTP ${res.status}); worst-case cost reserved because no usage was returned.`,
          );
        body = await res.json();
      } catch {
        return unknown(
          `${selection.provider} request failed or timed out; worst-case cost reserved because no usage was returned.`,
        );
      }
      const result = adapter.parse(body);
      if (!result.usage)
        return unknown('Provider returned no valid usage; worst-case cost reserved.');
      const u = result.usage;
      const billedInput = u.inputTokens + u.cacheWriteTokens + u.cacheWriteHourTokens;
      const base = {
        inputTokens: billedInput,
        outputTokens: u.outputTokens,
        costUsd: usageCost(selection.provider, selection.model, u),
      };
      if (billedInput > inputBound || u.outputTokens > prepared.maxTokens)
        return {
          ...base,
          diff: '',
          failure: 'Provider exceeded the reserved token bounds; no further LLM calls are allowed.',
          halt: true,
        };
      const tool = result.calls[0],
        args = tool?.arguments;
      if (
        result.failure ||
        result.calls.length !== 1 ||
        tool?.name !== 'submit_patch' ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((k) => k !== 'diff' && k !== 'explanation') ||
        !('diff' in args) ||
        typeof args.diff !== 'string' ||
        !('explanation' in args) ||
        typeof args.explanation !== 'string'
      )
        return {
          ...base,
          diff: '',
          failure:
            'Missing or invalid submit_patch: call submit_patch exactly once with string diff and explanation fields.',
        };
      return { ...base, diff: args.diff, explanation: args.explanation };
    },
  };
}
