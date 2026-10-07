import { definePack, type PackRule, replaceAtSite } from '../contract.js';
import type { TransformResult } from '../types.js';
import { declaresName, importSites, optionSites, renameOption } from './detect.js';

/**
 * AI SDK (`ai`) 6 → 7. Taken from the official migration guide and the 7.0.0 changelog
 * (`meta.sources`), checked 2026-10-07 against ai 7.0.130. Every rename below is a deprecated
 * alias that still compiles in 7.x, so its rule is `deprecated`; what the compiler rejects is
 * `breaking`. Changes the compiler cannot see are behavior notes, listed for review.
 */
const CALLS = new Set([
  'generateText',
  'streamText',
  'generateObject',
  'streamObject',
  'ToolLoopAgent',
]);
const TEXT_CALLS = new Set(['generateText', 'streamText', 'ToolLoopAgent']);
const UI_STREAMS = new Set([
  'createUIMessageStream',
  'toUIMessageStream',
  'toUIMessageStreamResponse',
  'pipeUIMessageStreamToResponse',
]);
const TELEMETRY_CALLS = new Set([...CALLS, 'embed', 'embedMany', 'rerank']);

/** A renamed option of the calls above: found by `detect`, renamed by `rewrite`. */
function option(
  id: string,
  key: string,
  to: string,
  callees: ReadonlySet<string>,
  summary: string,
): PackRule {
  return {
    id,
    summary,
    severity: 'deprecated',
    // Sites come from `detect`: no type diff reports an option key that still compiles.
    kinds: [],
    symbols: /$^/,
    guide: `${summary}. Rename the option and keep its value as it is.`,
    detect: (text) => optionSites(text, key, callees),
    rewrite: (text, finding) => renameOption(text, finding, key, to, callees),
  };
}

/** Where a line's trailing `//` comment starts, outside strings; the line's length without one. */
function codeEnd(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return i;
  }
  return line.length;
}

/** One occurrence of `before` in the code of the reported line, when it has exactly one. */
function onlyOnLine(
  text: string,
  line: number,
  before: RegExp,
  after: string,
  reason: string,
): TransformResult {
  const lines = text.split('\n');
  const current = lines[line - 1] ?? '';
  const end = codeEnd(current);
  const code = current.slice(0, end);
  const matches = code.match(new RegExp(before.source, 'g')) ?? [];
  if (matches.length !== 1)
    return { text, applied: false, reason: 'the reported line is not one occurrence to rename' };
  lines[line - 1] = `${code.replace(before, after)}${current.slice(end)}`;
  return { text: lines.join('\n'), applied: true, reason };
}

export const aiPack = definePack({
  meta: {
    package: 'ai',
    from: '>=6 <7',
    to: '>=7 <8',
    sources: [
      {
        title: 'Migrate AI SDK 6.x to 7.0',
        url: 'https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0',
      },
      {
        title: 'Migration guide source',
        url: 'https://github.com/vercel/ai/blob/main/content/docs/08-migration-guides/23-migration-guide-7-0.mdx',
      },
      {
        title: 'ai 7.0.0 changelog',
        url: 'https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md',
      },
    ],
    maintainer: 'uptide-dev',
  },
  defaultTarget: '7.0.130',
  rules: [
    option(
      'instructions',
      'system',
      'instructions',
      CALLS,
      '`system` is `instructions` (generateText, streamText, generateObject, streamObject, ToolLoopAgent)',
    ),
    option(
      'on-end',
      'onFinish',
      'onEnd',
      new Set([...TEXT_CALLS, ...UI_STREAMS]),
      '`onFinish` is `onEnd` (generateText, streamText, ToolLoopAgent, UI message streams)',
    ),
    option('on-step-end', 'onStepFinish', 'onStepEnd', CALLS, '`onStepFinish` is `onStepEnd`'),
    option(
      'telemetry',
      'experimental_telemetry',
      'telemetry',
      TELEMETRY_CALLS,
      '`experimental_telemetry` is `telemetry`',
    ),
    {
      id: 'is-step-count',
      summary: '`stepCountIs` is `isStepCount`',
      severity: 'deprecated',
      kinds: [],
      symbols: /$^/,
      guide: '`stepCountIs(n)` is `isStepCount(n)`: same stop condition.',
      detect: (text) => importSites(text, 'stepCountIs'),
      rewrite: (text, finding) => replaceAtSite(text, finding, 'stepCountIs', 'isStepCount'),
    },
    {
      id: 'full-stream',
      summary: '`fullStream` on a streamText result is `stream`',
      severity: 'deprecated',
      kinds: ['deprecated'],
      symbols: /#fullStream$/,
      guide:
        '`result.fullStream` is `result.stream`, the same parts. Rename a destructured `fullStream` and its uses together, unless the scope already has a `stream`.',
      rewrite: (text, finding) =>
        // A destructured local becomes `stream` only where no other `stream` can collide.
        declaresName(text, 'stream')
          ? onlyOnLine(
              text,
              finding.usage.line,
              /\.fullStream\b/,
              '.stream',
              '`.fullStream` is `.stream`',
            )
          : onlyOnLine(
              text,
              finding.usage.line,
              /\bfullStream\b/,
              'stream',
              '`fullStream` is `stream`',
            ),
    },
    {
      id: 'total-usage',
      summary: '`totalUsage` is `usage`, which covers every step in AI SDK 7',
      severity: 'deprecated',
      kinds: ['deprecated'],
      symbols: /#totalUsage$/,
      guide:
        '`result.totalUsage` is `result.usage`: in AI SDK 7 `usage` sums every step, which is what `totalUsage` was.',
      rewrite: (text, finding) =>
        onlyOnLine(text, finding.usage.line, /\.totalUsage\b/, '.usage', '`totalUsage` is `usage`'),
    },
    {
      id: 'ui-message-stream',
      summary:
        'stream result helpers (`toUIMessageStream`, `toUIMessageStreamResponse`, …) are standalone functions',
      severity: 'deprecated',
      kinds: ['deprecated'],
      symbols:
        /#(?:toUIMessageStream|toUIMessageStreamResponse|pipeUIMessageStreamToResponse|toTextStreamResponse|pipeTextStreamToResponse)$/,
      guide:
        '`result.toUIMessageStream(options)` is `toUIMessageStream({ stream: result.stream, ...options })`, imported from "ai"; `result.toUIMessageStreamResponse()` is `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`. Keep every option.',
    },
    {
      id: 'removed-experimental-option',
      summary:
        '`experimental_activeTools`, `experimental_prepareStep` and `experimental_output` are gone: `activeTools`, `prepareStep`, `output`',
      severity: 'breaking',
      kinds: ['type', 'signature'],
      symbols: /^TS2353$/,
      message: /'experimental_(?:activeTools|prepareStep|output)'/,
      guide:
        'The experimental option was promoted: rename `experimental_activeTools` to `activeTools`, `experimental_prepareStep` to `prepareStep`, `experimental_output` to `output`. Nothing else changes.',
      rewrite: (text, finding) => {
        const name = /'experimental_(activeTools|prepareStep|output)'/.exec(
          finding.usage.compileError ?? '',
        )?.[1];
        return name
          ? onlyOnLine(
              text,
              finding.usage.line,
              new RegExp(`\\bexperimental_${name}\\b`),
              name,
              `\`experimental_${name}\` is \`${name}\``,
            )
          : { text, applied: false, reason: 'not a removed experimental option' };
      },
    },
    {
      id: 'telemetry-metadata',
      summary:
        'telemetry `metadata` is gone: per-call values move to `runtimeContext`, named in `telemetry.includeRuntimeContext`',
      severity: 'breaking',
      // The type diff names it (`TelemetrySettings#metadata` removed); the compiler alone says TS2353.
      kinds: ['removed', 'type', 'signature'],
      symbols: /(?:^TS2353$|#metadata$)/,
      message: /'metadata'/,
      guide:
        'Move each `metadata` entry to a top-level `runtimeContext: { key: value }` on the call, and list it in `telemetry: { includeRuntimeContext: { key: true } }`. Keep functionId and every other telemetry setting.',
    },
    {
      id: 'tool-context',
      summary:
        'tool execution options carry a typed `context`: `experimental_context` is `context`, and a direct `tool.execute` call passes one',
      severity: 'breaking',
      kinds: ['type', 'signature', 'required'],
      symbols: /^TS\d+$/,
      message: /'(?:experimental_)?context'/,
      guide:
        'A tool reads `context` (was `experimental_context`) from its execute options; the call site supplies it per tool with `toolsContext`, and shared values with `runtimeContext` (was `context`). A direct `tool.execute(input, { toolCallId, messages })` call adds `context`. Do not cast to make it compile.',
    },
  ],
  behavior: [
    {
      id: 'telemetry-registration',
      summary:
        'AI SDK 7 emits no OpenTelemetry spans by itself: register an integration once (`registerTelemetry(new OpenTelemetry())` from "ai" and "@ai-sdk/otel"), or tracing silently stops',
      reported: ['decision'],
    },
    {
      id: 'results-cover-all-steps',
      summary:
        '`usage`, `content`, `toolCalls`, `toolResults`, `files`, `sources` and `warnings` on a result and on the `onEnd` event now cover every step; the last step alone is `finalStep`',
      reported: ['decision'],
    },
    {
      id: 'system-messages-rejected',
      summary:
        'system messages inside `messages` or `prompt` are rejected by default: pass them as `instructions`, or set `allowSystemInMessages`',
      reported: ['decision'],
    },
    {
      id: 'prepare-step-carries-forward',
      summary:
        'what `prepareStep` returns for instructions and messages now carries forward to later steps',
      reported: ['decision'],
    },
    {
      id: 'ui-stream-errors-redacted',
      summary:
        'UI message streams send "An error occurred." instead of the error: pass `onError` to keep the details',
      reported: ['decision'],
    },
    {
      id: 'companion-packages',
      summary:
        "`@ai-sdk/react`, `@ai-sdk/provider` and the provider packages move to their AI SDK 7 majors with `ai`; this upgrade bumps `ai` alone, so bump them on the same branch (ai 7 next to @ai-sdk/react 3 mixes two majors' types)",
      reported: ['decision'],
    },
    {
      id: 'esm-only',
      summary: 'every `ai` and `@ai-sdk/*` package is ESM-only and needs Node 22 or later',
      reported: ['decision'],
    },
  ],
  instructions:
    'Migrate only the reported site to AI SDK 7, from the compiler error and the guide above. Keep every value, prompt, tool and callback body as it is. Never cast or suppress a diagnostic to make it compile. If the site needs a decision the guide leaves open (which step a value should come from, what a runtime context holds), say so instead of choosing.',
});
