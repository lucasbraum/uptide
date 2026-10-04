import { openaiBaseUrl } from './config.js';
import { PATCH_TOOL, SYSTEM } from './prompt.js';
import type { Adapter, Provider, ToolCall, Usage } from './types.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown, optional = false): number =>
  v === undefined && optional
    ? 0
    : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? v
      : NaN;
function usage(
  input: unknown,
  output: unknown,
  cached?: unknown,
  write?: unknown,
  hour?: unknown,
): Usage | undefined {
  const u = {
    inputTokens: count(input),
    outputTokens: count(output),
    cachedInputTokens: count(cached, true),
    cacheWriteTokens: count(write, true),
    cacheWriteHourTokens: count(hour, true),
  };
  return Object.values(u).every(Number.isFinite) && u.cachedInputTokens <= u.inputTokens
    ? u
    : undefined;
}
function call(name: unknown, args: unknown): ToolCall {
  let parsed = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = undefined;
    }
  }
  return { name: typeof name === 'string' ? name : '', arguments: parsed };
}
export const adapters: Record<Provider, Adapter> = {
  anthropic: {
    prepare: (model, messages, maxTokens) => ({
      url: 'https://api.anthropic.com/v1/messages',
      maxTokens,
      body: {
        model,
        max_tokens: maxTokens,
        service_tier: 'standard_only',
        system: SYSTEM,
        messages,
        tools: [
          {
            name: PATCH_TOOL.name,
            description: PATCH_TOOL.description,
            input_schema: PATCH_TOOL.parameters,
          },
        ],
        tool_choice: { type: 'tool', name: PATCH_TOOL.name },
      },
    }),
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    parse: (value) => {
      const b = object(value),
        u = object(b.usage),
        creation = object(u.cache_creation);
      const read = count(u.cache_read_input_tokens, true);
      const created = count(u.cache_creation_input_tokens, true);
      const hour = count(creation.ephemeral_1h_input_tokens, true);
      return {
        calls: array(b.content)
          .map(object)
          .filter((c) => c.type === 'tool_use')
          .map((c) => call(c.name, c.input)),
        usage: usage(count(u.input_tokens) + read, u.output_tokens, read, created - hour, hour),
        ...(b.stop_reason && b.stop_reason !== 'tool_use'
          ? { failure: 'Response did not complete submit_patch.' }
          : {}),
      };
    },
  },
  openai: {
    prepare: (model, messages, maxTokens, baseUrl) => ({
      url: `${openaiBaseUrl(baseUrl ?? 'https://api.openai.com/v1')}/responses`,
      maxTokens,
      body: {
        model,
        instructions: SYSTEM,
        input: messages,
        max_output_tokens: maxTokens,
        store: false,
        service_tier: 'default',
        parallel_tool_calls: false,
        tools: [{ type: 'function', ...PATCH_TOOL, strict: true }],
        tool_choice: { type: 'function', name: PATCH_TOOL.name },
      },
    }),
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (value) => {
      const b = object(value),
        u = object(b.usage),
        details = object(u.input_tokens_details);
      const written = count(details.cache_write_tokens, true);
      return {
        calls: array(b.output)
          .map(object)
          .filter((c) => c.type === 'function_call')
          .map((c) => call(c.name, c.arguments)),
        usage: usage(
          count(u.input_tokens) - written,
          u.output_tokens,
          details.cached_tokens,
          written,
        ),
        ...(b.status && b.status !== 'completed'
          ? { failure: 'Response did not complete submit_patch.' }
          : {}),
      };
    },
  },
  gemini: {
    prepare: (model, messages, maxTokens) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      maxTokens,
      body: {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
        tools: [
          {
            functionDeclarations: [
              {
                name: PATCH_TOOL.name,
                description: PATCH_TOOL.description,
                parameters: {
                  type: 'OBJECT',
                  properties: { diff: { type: 'STRING' }, explanation: { type: 'STRING' } },
                  required: ['diff', 'explanation'],
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [PATCH_TOOL.name] },
        },
      },
    }),
    headers: (key) => ({ 'x-goog-api-key': key }),
    parse: (value) => {
      const b = object(value),
        u = object(b.usageMetadata),
        candidates = array(b.candidates).map(object);
      const c = candidates[0] ?? {};
      return {
        calls: candidates
          .flatMap((c) => array(object(c.content).parts))
          .map(object)
          .filter((p) => p.functionCall !== undefined)
          .map((p) => {
            const f = object(p.functionCall);
            return call(f.name, f.args);
          }),
        usage: usage(
          u.promptTokenCount,
          count(u.candidatesTokenCount) + count(u.thoughtsTokenCount, true),
          u.cachedContentTokenCount,
        ),
        ...(c.finishReason && c.finishReason !== 'STOP'
          ? { failure: 'Response did not complete submit_patch.' }
          : {}),
      };
    },
  },
};
