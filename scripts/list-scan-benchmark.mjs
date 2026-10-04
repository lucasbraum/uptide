import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDependencies } from '../packages/core/dist/index.js';

const synthetic = mkdtempSync(join(tmpdir(), 'uptide-scan-benchmark-'));
try {
  mkdirSync(synthetic, { recursive: true });
  writeFileSync(
    join(synthetic, 'package.json'),
    JSON.stringify({
      name: 'synthetic-scan',
      dependencies: {
        sample: '1.0.0',
        prettier: '1.0.0',
        standard: '1.0.0',
        'lint-staged': '1.0.0',
      },
      standard: { ignore: ['app/legacy/**'] },
    }),
  );
  writeFileSync(join(synthetic, '.gitignore'), 'generated/\n');
  writeFileSync(
    join(synthetic, '.lintstagedrc'),
    JSON.stringify({ linters: { '*.js': ['standard --fix'] }, ignore: ['app/bower_components/'] }),
  );
  const noise = Array.from(
    { length: 600 },
    (_, i) =>
      `function local${i}(value) { const copy = { value, nested: [1, 2, 3] }; return copy.value + ${i}; }`,
  ).join('\n');
  for (let i = 0; i < 1844; i++) {
    const folder =
      i < 400
        ? 'app/bower_components'
        : i < 800
          ? 'vendor'
          : i < 1100
            ? 'generated'
            : i < 1300
              ? 'app/legacy'
              : 'src';
    mkdirSync(join(synthetic, folder), { recursive: true });
    writeFileSync(
      join(synthetic, folder, `file-${i}.js`),
      (i >= 1300 && i < 1460 ? "import sample from 'sample'; sample();\n" : '') + noise,
    );
  }
  mkdirSync(join(synthetic, 'styles'), { recursive: true });
  for (let i = 0; i < 1293; i++)
    writeFileSync(
      join(synthetic, 'styles', `style-${i}.scss`),
      Array.from({ length: 150 }, (_, n) => `.item-${n} { color: #123456; margin: 0; }`).join('\n'),
    );
  for (const cwd of [...process.argv.slice(2), synthetic]) {
    const report = await listDependencies({
      cwd,
      verbose: true,
      fetcher: { resolve: async () => '99.0.0', metadata: async () => ({}) },
    });
    console.log(
      JSON.stringify({
        repo: cwd === synthetic ? 'synthetic (1844 sources / 1293 assets)' : cwd,
        timing: report.timing,
        usage: report.packages.find((p) => p.name === 'sample')?.usage,
      }),
    );
  }
} finally {
  rmSync(synthetic, { recursive: true, force: true });
}
