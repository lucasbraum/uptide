import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { listDependencies } from './list.js';

const fixture = fileURLToPath(
  new URL('../../../../fixtures/repos/list-accuracy/tool-ignore-scope/', import.meta.url),
);
it('tool ignore scopes never hide app usage, including a blanket **/*.js prettier ignore', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-tool-ignore-'));
  try {
    cpSync(fixture, cwd, { recursive: true });
    const fetcher = { resolve: async () => '2.0.0', metadata: async () => ({}) };
    const report = await listDependencies({ cwd, fetcher, verbose: true });
    expect(report.packages).toHaveLength(4);
    for (const p of report.packages)
      expect(p).toMatchObject({ classification: 'used', usage: { files: 1, callSites: 1 } });
    expect(report.scanWarnings).toBeUndefined();
    expect(report.timing.files).toMatchObject({
      candidateSources: 4,
      ignoredSources: 0,
      parsed: 4,
    });
    for (const file of ['.prettierignore', '.eslintignore', '.stylelintignore', '.lintstagedrc'])
      rmSync(join(cwd, file));
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    delete manifest.standard;
    delete manifest['lint-staged'];
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    const without = await listDependencies({ cwd, fetcher });
    expect(report.packages.map((p) => p.usage)).toEqual(without.packages.map((p) => p.usage));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
