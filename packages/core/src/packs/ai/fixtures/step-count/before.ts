import { stepCountIs, streamText } from 'ai'; // @uptide is-step-count at:stepCountIs
import { stepCountIs as stopAfter } from 'ai'; // @uptide is-step-count at:stepCountIs

export const a = streamText({ model, prompt: 'p', stopWhen: stepCountIs(5) }); // @uptide is-step-count at:stepCountIs
export const b = streamText({ model, prompt: 'p', stopWhen: [stepCountIs(10), done] }); // @uptide is-step-count at:stepCountIs
// The alias keeps its name; a name that only starts the same is not the import.
export const c = streamText({ model, prompt: 'p', stopWhen: stopAfter(3) });
export const stepCountIsDefault = 5; // @uptide is-step-count keep at:stepCountIsDefault
