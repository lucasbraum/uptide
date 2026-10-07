import { useChat } from '@ai-sdk/react';
import { createUIMessageStream, generateObject, generateText as generate, streamText, ToolLoopAgent } from 'ai';
import { complete } from 'other-llm';

const system = 'You are terse.';

export async function title(prompt: string) {
  const { text } = await generate({
    model,
    system: 'Write a title.', // @uptide instructions
    prompt,
    onStepFinish: (step) => log(step), // @uptide on-step-end
    experimental_telemetry: { isEnabled: true, functionId: 'title' }, // @uptide telemetry
    onFinish: ({ text }) => log(text), // @uptide on-end
  });
  return text;
}

export const reply = streamText({ model, system, prompt: 'hi' }); // @uptide instructions at:system

export const agent = new ToolLoopAgent({
  model,
  system: 'Use the tools.', // @uptide instructions
  onFinish() {}, // @uptide on-end
});

export const ui = createUIMessageStream({
  execute: ({ writer }) => writer.merge(reply.toUIMessageStream({ onFinish: () => {} })), // @uptide on-end at:onFinish
  onFinish: async ({ messages }) => save(messages), // @uptide on-end
});

// Left alone: another library's options, a hook from @ai-sdk/react, generateObject's onFinish.
export const other = complete({ system: 'x' }); // @uptide instructions keep at:system
export const chat = useChat({ onFinish: () => {} }); // @uptide on-end keep at:onFinish
export const object = generateObject({ model, schema, prompt: 'p', onFinish: () => {} }); // @uptide on-end keep at:onFinish
export const traced = complete({ onStepFinish: log, experimental_telemetry: on }); // @uptide on-step-end keep at:onStepFinish
export const tracedToo = complete({ experimental_telemetry: on }); // @uptide telemetry keep at:experimental_telemetry
