import type { Provider } from './types.js';

export interface ModelCapabilities {
  supportsForcedTool: boolean;
  /** Omitted means the model's API default; overrides are for controlled evaluations. */
  defaultEffort?: 'low' | 'medium' | 'high';
}
export const CAPABILITY_DATE = '2026-10-04';
export const CAPABILITY_SOURCES = {
  'claude-opus-5-5': 'https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5',
  'claude-fable-5-1': 'https://platform.claude.com/docs/en/models/fable-5-1/overview',
  'claude-sonnet-5-5': 'https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide',
} as const;
// Capabilities belong to models: changing a default must not change another model's protocol.
export const MODEL_CAPABILITIES: Record<Provider, Record<string, ModelCapabilities>> = {
  anthropic: {
    'claude-sonnet-4-6': { supportsForcedTool: true },
    'claude-sonnet-5-5': { supportsForcedTool: false, defaultEffort: 'medium' },
    'claude-opus-5-5': { supportsForcedTool: false },
    'claude-fable-5-1': { supportsForcedTool: false },
    'claude-haiku-4-5-20251001': { supportsForcedTool: true },
  },
  openai: {
    'gpt-6.1-sol': { supportsForcedTool: true },
    'gpt-6-astra': { supportsForcedTool: true },
    'gpt-6-luna': { supportsForcedTool: true },
    'gpt-5-pro': { supportsForcedTool: true },
  },
  gemini: {
    'gemini-3.8-flash': { supportsForcedTool: true },
    'gemini-3.7-flash': { supportsForcedTool: true },
    'gemini-3.1-pro-preview': { supportsForcedTool: true },
  },
};
export function modelCapabilities(provider: Provider, model: string): ModelCapabilities {
  const entries = MODEL_CAPABILITIES[provider];
  // Preserve forced calls for unlisted compatible models until a documented exception is known.
  return (
    (Object.hasOwn(entries, model) ? entries[model] : undefined) ?? { supportsForcedTool: true }
  );
}
