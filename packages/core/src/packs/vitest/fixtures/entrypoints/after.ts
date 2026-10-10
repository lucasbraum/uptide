import { expect } from 'vitest';
import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node'; // @uptide removed-entrypoints keep
import type { Reporter } from 'vitest/node'; // @uptide removed-entrypoints at:'vitest/reporters'
import { coverageConfigDefaults } from "vitest/node"; // @uptide removed-entrypoints at:"vitest/coverage"
import { populateGlobal } from 'vitest/runtime'; // @uptide removed-entrypoints at:'vitest/environments'
export { SnapshotState } from 'vitest/runtime'; // @uptide removed-entrypoints at:'vitest/snapshot'
const reporters = await import('vitest/node'); // @uptide removed-entrypoints at:'vitest/reporters'

export default defineConfig({ test: { coverage: { exclude: coverageConfigDefaults.exclude } } });
export { expect, BaseSequencer, populateGlobal, reporters };
export type { Reporter };
