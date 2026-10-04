import { providerFixer } from '../llm/fixer.js';
import { DEFAULT_MODELS } from '../llm/pricing.js';
import type { Fixer } from './types.js';

/** Kept for callers that supplied an Anthropic key/fetcher directly. */
export function anthropicFixer(
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetcher: typeof fetch = fetch,
): Fixer | undefined {
  return providerFixer(
    { provider: 'anthropic', model: DEFAULT_MODELS.anthropic, available: !!apiKey },
    { env: { ANTHROPIC_API_KEY: apiKey }, fetch: fetcher },
  );
}
