import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// TypeScript (inside ts-morph) is CommonJS: it calls require() for Node builtins and reads
// __filename. An ES module has neither, so every chunk starts by recreating them.
const cjsGlobals = [
  "import { createRequire as __uptideCreateRequire } from 'node:module';",
  "import { fileURLToPath as __uptideFileURLToPath } from 'node:url';",
  'const require = __uptideCreateRequire(import.meta.url);',
  'const __filename = __uptideFileURLToPath(import.meta.url);',
  "const __dirname = __uptideFileURLToPath(new URL('.', import.meta.url));",
].join('\n');

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'telemetry-sender': 'src/telemetry/sender.ts',
    // Analysis runs in this thread so the main one can keep drawing progress.
    'engine-worker': 'src/engine-worker.ts',
    // The engine starts `./worker.js` next to whichever file holds its code; chunks and
    // this entry both land flat in dist/, so the relative URL keeps resolving.
    'list-worker': fileURLToPath(import.meta.resolve('@uptide/core/list-worker')),
    worker: fileURLToPath(import.meta.resolve('@uptide/core/worker')),
  },
  format: ['esm'],
  clean: true,
  target: 'node20',
  splitting: true,
  // `npx uptide` installs one package: the engine and every dependency are inlined.
  noExternal: [/.*/],
  banner: { js: cjsGlobals },
  // A quarter off the install size; identifiers stay, so stack traces remain readable.
  minifyWhitespace: true,
  minifySyntax: true,
  // The engine is bundled in: it learns the published version (and so its dist-tag) here.
  define: {
    __UPTIDE_TELEMETRY_KEY__: JSON.stringify(process.env.UPTIDE_TELEMETRY_BUILD_KEY ?? ''),
    __UPTIDE_TELEMETRY_HOST__: JSON.stringify(
      process.env.UPTIDE_TELEMETRY_BUILD_HOST ?? 'https://eu.i.posthog.com',
    ),
    __UPTIDE_VERSION__: JSON.stringify(version),
    __UPTIDE_CLI_VERSION__: JSON.stringify(version),
  },
});
