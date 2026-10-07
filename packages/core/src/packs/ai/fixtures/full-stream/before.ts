import { streamText } from 'ai';

export async function* parts(prompt: string) {
  const { fullStream } = streamText({ model, prompt }); // @uptide full-stream at:fullStream kind:deprecated path:StreamTextResult#fullStream
  for await (const part of fullStream) yield part; // @uptide full-stream at:fullStream kind:deprecated path:StreamTextResult#fullStream
}
