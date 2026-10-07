import { streamText } from 'ai';

export async function* parts(prompt: string) {
  const { stream } = streamText({ model, prompt }); // @uptide full-stream at:fullStream kind:deprecated path:StreamTextResult#fullStream
  for await (const part of stream) yield part; // @uptide full-stream at:fullStream kind:deprecated path:StreamTextResult#fullStream
}
