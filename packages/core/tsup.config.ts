import { defineConfig } from 'tsup';
import { uptideVersionInfo } from './src/version.js';

const metadata = uptideVersionInfo();

export default defineConfig({
  define: {
    __UPTIDE_BUILD_VERSION__: JSON.stringify(metadata.uptideVersion),
    __UPTIDE_BUILD_COMMIT__: JSON.stringify(metadata.uptideCommit),
    __UPTIDE_BUILD_DIRTY__: JSON.stringify(metadata.uptideDirty),
  },
  entry: { index: 'src/index.ts', worker: 'src/check/worker.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
