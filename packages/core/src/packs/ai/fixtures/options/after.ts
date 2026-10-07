import { useChat } from '@ai-sdk/react';
import { createUIMessageStream, generateObject, generateText as generate, streamText, ToolLoopAgent } from 'ai';
import { complete } from 'other-llm';

const system = 'You are terse.';

export async function title(prompt: string) {
  const { text } = await generate({
    model,
    instructions: 'Write a title.', // @uptide instructions
    prompt,
    onStepEnd: (step) => log(step), // @uptide on-step-end
    telemetry: { isEnabled: true, functionId: 'title' }, // @uptide telemetry
    onEnd: ({ text }) => log(text), // @uptide on-end
  });
  return text;
}

export const reply = streamText({ model, instructions: system, prompt: 'hi' }); // @uptide instructions at:system

export const agent = new ToolLoopAgent({
  model,
  instructions: 'Use the tools.', // @uptide instructions
  onEnd() {}, // @uptide on-end
});

export const ui = createUIMessageStream({
  execute: ({ writer }) => writer.merge(reply.toUIMessageStream({ onEnd: () => {} })), // @uptide on-end at:onFinish
  onEnd: async ({ messages }) => save(messages), // @uptide on-end
});

// Left alone: another library's options, a hook from @ai-sdk/react, generateObject's onFinish.
export const other = complete({ system: 'x' }); // @uptide instructions keep at:system
export const chat = useChat({ onFinish: () => {} }); // @uptide on-end keep at:onFinish
export const object = generateObject({ model, schema, prompt: 'p', onFinish: () => {} }); // @uptide on-end keep at:onFinish
export const traced = complete({ onStepFinish: log, experimental_telemetry: on }); // @uptide on-step-end keep at:onStepFinish
export const tracedToo = complete({ experimental_telemetry: on }); // @uptide telemetry keep at:experimental_telemetry
