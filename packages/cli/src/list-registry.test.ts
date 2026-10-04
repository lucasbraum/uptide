import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const fixture = fileURLToPath(
  new URL('../../../fixtures/repos/list-accuracy/private-registry/', import.meta.url),
);
const execute = promisify(execFile);
it.skipIf(!existsSync(bin)).each([true, false])(
  'packaged CLI handles private auth (accepted=%s) without leaking credentials',
  async (accepted) => {
    const cwd = mkdtempSync(join(tmpdir(), 'uptide-private-cli-'));
    const seen: (string | undefined)[] = [];
    const secret = 'synthetic-cli-registry-secret';
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      if (!accepted) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: `rejected https://${secret}@registry.invalid` }));
        return;
      }
      res.end(
        JSON.stringify({
          'dist-tags': { latest: '2.0.0' },
          versions: { '1.0.0': {}, '2.0.0': {} },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      cpSync(fixture, cwd, { recursive: true });
      writeFileSync(join(cwd, 'package-lock.json'), '{}');
      const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      writeFileSync(
        join(cwd, '.npmrc'),
        `@example:registry=http://${host}\n//${host}/:_authToken=\${SYNTHETIC_REGISTRY_TOKEN}\n`,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
      );
      const result = await execute(
        process.execPath,
        [bin, 'list', '--json', '--html', 'report.html', '--ci'],
        {
          cwd,
          env: {
            ...env,
            UPTIDE_TELEMETRY: '0',
            UPTIDE_CACHE_DIR: join(cwd, 'cache'),
            NPM_CONFIG_USERCONFIG: '/nonexistent',
            SYNTHETIC_REGISTRY_TOKEN: secret,
          },
          timeout: 10000,
        },
      ).then(
        (output) => ({ ...output, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.code).toBe(accepted ? 0 : 2);
      expect(seen).toHaveLength(2);
      expect(seen.every((value) => value === `Bearer ${secret}`)).toBe(true);
      const report = JSON.parse(result.stdout);
      expect(report.failures).toHaveLength(accepted ? 0 : 2);
      expect(report.unknown).toHaveLength(accepted ? 0 : 2);
      const html = readFileSync(join(cwd, 'report.html'), 'utf8');
      expect(html.match(/class="incomplete-row"/g)?.length ?? 0).toBe(accepted ? 0 : 2);
      expect(result.stdout + result.stderr + html).not.toContain(secret);
      expect(result.stdout + result.stderr + html).not.toContain(`http://${host}`);
      expect(existsSync(join(cwd, 'cache/registry'))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

it.skipIf(!existsSync(bin))(
  'packaged source worker scans large files and reports skipped counts',
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'uptide-source-worker-cli-'));
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          'dist-tags': { latest: '2.0.0' },
          versions: { '1.0.0': {}, '2.0.0': {} },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'worker-fixture', dependencies: { sample: '1.0.0' } }),
      );
      writeFileSync(join(cwd, 'package-lock.json'), '{}');
      writeFileSync(
        join(cwd, '.npmrc'),
        `registry=http://127.0.0.1:${(server.address() as AddressInfo).port}\n`,
      );
      // Large comments cross the worker threshold without inflating AST time on slower CI.
      const text =
        "import sample from 'sample'; sample(); register(sample);\n/*" +
        'synthetic '.repeat(26000) +
        '*/';
      for (let i = 0; i < 32; i++) writeFileSync(join(cwd, `app-${i}.js`), text);
      writeFileSync(join(cwd, 'app.min.js'), "import 'sample';");
      const { stdout, stderr } = await execute(
        process.execPath,
        [bin, 'list', '--json', '--verbose', '--ci'],
        {
          cwd,
          timeout: 15000,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
            ),
            UPTIDE_TELEMETRY: '0',
            NPM_CONFIG_USERCONFIG: '/nonexistent',
          },
        },
      );
      const report = JSON.parse(stdout);
      expect(report.packages[0].usage).toMatchObject({ files: 32, callSites: 32, references: 32 });
      expect(report.timing.files.parsed).toBe(32);
      // Single-CPU containers correctly stay in-process.
      expect(report.timing.files.workers).toBe(
        availableParallelism() > 1 ? Math.min(4, availableParallelism()) : 0,
      );
      expect(stderr).toContain('generated files (*.min.js, *.bundle.js, *.map): 1 file');
      expect(report.failures).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  20000,
);
