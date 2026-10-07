import { smoothStream, streamText } from 'ai';

export const result = streamText({
  model,
  prompt: 'p',
  activeTools: ['search'], // @uptide removed-experimental-option at:experimental_activeTools kind:type path:TS2353 message:"Object literal may only specify known properties, and 'experimental_activeTools' does not exist in type"
  prepareStep: prepare, // @uptide removed-experimental-option at:experimental_prepareStep kind:type path:TS2353 message:"Object literal may only specify known properties, and 'experimental_prepareStep' does not exist in type"
  // Another rejected option is another rule's: never renamed by this one.
  experimental_transform: smoothStream(), // @uptide removed-experimental-option keep at:experimental_transform kind:type path:TS2353 message:"Object literal may only specify known properties, and 'metadata' does not exist in type"
});
