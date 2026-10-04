import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listDependencies } from './list.js';

const roots: string[] = [];
const base = fileURLToPath(
  new URL('../../../../fixtures/repos/list-accuracy/legacy-lint-staged/', import.meta.url),
);
function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-legacy-tasks-'));
  roots.push(cwd);
  cpSync(base, cwd, { recursive: true });
  return cwd;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fetcher = {
  resolve: async () => '2.0.0',
  metadata: async (name: string, version: string) =>
    name === 'unused-plugin'
      ? { peerDependencies: { prettier: version === '2.0.0' ? '^2' : '^1' } }
      : {},
};
it('keeps each group member classified by its own evidence, with uncalled pretty-quick unused', async () => {
  const report = await listDependencies({ cwd: fixture(), fetcher });
  expect(report.packages.find((p) => p.name === 'prettier')).toMatchObject({
    classification: 'tooling',
    reasons: expect.arrayContaining(['lint-staged command', 'config file .prettierrc']),
    peerOf: ['unused-plugin'],
  });
  for (const name of ['unused-plugin', 'pretty-quick'])
    expect(report.packages.find((p) => p.name === name)?.classification).toBe('possibly-unused');
  expect(report.groups[0]).toMatchObject({ lead: 'unused-plugin', name: 'unused-plugin' });
  expect(report.groups[0]?.members.map((p) => p.name).sort()).toEqual([
    'prettier',
    'unused-plugin',
  ]);
});
for (const format of ['legacy', 'flat'] as const)
  for (const file of [
    '.lintstagedrc',
    '.lintstagedrc.yaml',
    'lint-staged.config.js',
    'lint-staged.config.mjs',
    'lint-staged.config.ts',
    'package.json',
  ]) {
    it(`reads ${format} commands from ${file}, never ignore globs`, async () => {
      const cwd = fixture();
      rmSync(join(cwd, '.lintstagedrc'));
      const linters = { '*.js': ['prettier --write', 'standard --fix'] };
      const config = {
        ...(format === 'legacy' ? { linters } : linters),
        ignore: ['pretty-quick', 'generated/'],
      };
      if (file === 'package.json') {
        const manifest = JSON.parse(readFileSync(join(cwd, file), 'utf8'));
        manifest['lint-staged'] = config;
        writeFileSync(join(cwd, file), JSON.stringify(manifest));
      } else
        writeFileSync(
          join(cwd, file),
          file.endsWith('.yaml')
            ? (format === 'legacy'
                ? 'linters:\n  "*.js": [prettier --write, standard --fix]\n'
                : '"*.js": [prettier --write, standard --fix]\n') +
                'ignore: [pretty-quick, generated/]\n'
            : /\.[cm]?ts$|\.[cm]?js$/.test(file)
              ? `throw new Error('never execute'); ${file.endsWith('.js') ? 'module.exports =' : 'export default'} ${JSON.stringify(config)};`
              : JSON.stringify(config),
        );
      mkdirSync(join(cwd, 'generated'));
      writeFileSync(join(cwd, 'generated/use.js'), "import 'pretty-quick';");
      const report = await listDependencies({ cwd, fetcher, verbose: true });
      for (const name of ['prettier', 'standard'])
        expect(report.packages.find((p) => p.name === name)?.reasons).toContain(
          'lint-staged command',
        );
      expect(report.packages.find((p) => p.name === 'pretty-quick')?.classification).toBe(
        'possibly-unused',
      );
      expect(report.timing.files?.skipped?.['lint-staged.ignore']?.directories).toBe(1);
    });
  }
