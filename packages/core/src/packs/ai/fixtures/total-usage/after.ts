import { streamText } from 'ai';

export async function cost(prompt: string) {
  const result = streamText({ model, prompt });
  const used = await result.usage; // @uptide total-usage at:.totalUsage kind:deprecated path:StreamTextResult#totalUsage
  const totalUsage = used.inputTokens; // @uptide total-usage keep at:totalUsage kind:deprecated path:StreamTextResult#totalUsage
  return totalUsage;
}
