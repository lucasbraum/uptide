import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
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
it('forwards real workspace worker events without serializing the callback', () => {
  const entry = pathToFileURL(resolve(import.meta.dirname, '../../dist/index.js')).href;
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
