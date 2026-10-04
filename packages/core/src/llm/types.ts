export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface ToolCall {
  name: string;
  arguments: unknown;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWriteHourTokens: number;
}
export interface LlmResponse {
  calls: ToolCall[];
  usage?: Usage;
  failure?: string;
}
export interface Call {
  url: string;
  body: Record<string, unknown>;
  maxTokens: number;
}
export interface Adapter {
  prepare(model: string, messages: LlmMessage[], maxTokens: number, baseUrl?: string): Call;
  headers(key: string): Record<string, string>;
  parse(body: unknown): LlmResponse;
}
