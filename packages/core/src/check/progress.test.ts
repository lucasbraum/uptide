import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { type ProgressEvent, progress } from '../domain/progress.js';

it('pairs progress events even when a phase fails', async () => {
  const events: ProgressEvent[] = [];
  await expect(
    progress(
      (e) => events.push(e),
      { phase: 'fetch', package: 'demo' },
      () => {
        throw new Error('offline');
      },
    ),
  ).rejects.toThrow('offline');
  expect(events.map((e) => e.state)).toEqual(['start', 'done']);
  expect(events[1]?.ms).toBeGreaterThanOrEqual(0);
});
// The built worker (dist/worker.js), not the source one the rest of the suite runs. Built into
// a private directory: `pnpm build` cleans and rewrites dist/, so a build running alongside
// (turbo, an editor, a second terminal) could delete the bundle mid-import (#58). Inside
// node_modules so the bundle's bare imports still resolve from the package.
const pkg = resolve(import.meta.dirname, '../..');
mkdirSync(join(pkg, 'node_modules'), { recursive: true });
const privateDist = mkdtempSync(join(pkg, 'node_modules/.uptide-progress-test-'));
afterAll(() => rmSync(privateDist, { recursive: true, force: true }));
it('forwards real workspace worker events without serializing the callback', () => {
  const tsup = join(
    dirname(createRequire(import.meta.url).resolve('tsup/package.json')),
    'dist/cli-default.js',
  );
  execFileSync(process.execPath, [tsup, '--no-dts', '--no-sourcemap', '--out-dir', privateDist], {
    cwd: pkg,
  });
  const entry = pathToFileURL(join(privateDist, 'index.js')).href;
  const cwd = resolve(import.meta.dirname, '../../../../fixtures/repos/workspace-consumer');
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {check} from ${JSON.stringify(entry)}; const events=[]; await check({cwd:${JSON.stringify(cwd)},only:[],onProgress:e=>events.push(e)}); console.log(JSON.stringify(events));`,
    ],
    { encoding: 'utf8' },
  );
  const events: ProgressEvent[] = JSON.parse(output);
  for (const workspace of ['.', 'packages/app', 'packages/lib']) {
    expect(events.filter((e) => e.workspace === workspace).map((e) => e.state)).toEqual([
      'start',
      'done',
    ]);
  }
});
