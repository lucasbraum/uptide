import { isStepCount, streamText } from 'ai'; // @uptide is-step-count at:stepCountIs
import { isStepCount as stopAfter } from 'ai'; // @uptide is-step-count at:stepCountIs

export const a = streamText({ model, prompt: 'p', stopWhen: isStepCount(5) }); // @uptide is-step-count at:stepCountIs
export const b = streamText({ model, prompt: 'p', stopWhen: [isStepCount(10), done] }); // @uptide is-step-count at:stepCountIs
// The alias keeps its name; a name that only starts the same is not the import.
export const c = streamText({ model, prompt: 'p', stopWhen: stopAfter(3) });
export const stepCountIsDefault = 5; // @uptide is-step-count keep at:stepCountIsDefault
