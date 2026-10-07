import { streamText } from 'ai';

// A `stream` already in the file: a destructured `fullStream` keeps its name.
export async function relay(stream: WritableStream, prompt: string) {
  const { fullStream } = streamText({ model, prompt }); // @uptide full-stream keep at:fullStream kind:deprecated path:StreamTextResult#fullStream
  const result = streamText({ model, prompt });
  for await (const part of result.stream) await write(stream, part); // @uptide full-stream at:.fullStream kind:deprecated path:StreamTextResult#fullStream
  return fullStream;
}
