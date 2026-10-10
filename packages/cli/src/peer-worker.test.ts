import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
it.skipIf(!existsSync(bin))(
  'preserves grouped peer errors across the packaged worker boundary',
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'uptide-peer-worker-'));
    const peers = { react: '^18', 'react-dom': '^18' };
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '').slice(1));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          versions:
            name === 'plugin'
              ? {
                  '1.0.0': { peerDependencies: peers },
                  '1.1.0': { peerDependencies: { react: '^19', 'react-dom': '^19' } },
                }
              : {
                  '18.2.0': { peerDependencies: name === 'react-dom' ? { react: '^18' } : {} },
                  '19.3.0': { peerDependencies: name === 'react-dom' ? { react: '^19' } : {} },
                },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const dependencies = { react: '18.2.0', 'react-dom': '18.2.0', plugin: '1.0.0' };
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies }));
      const packages: Record<string, object> = { '': { dependencies } };
      for (const [name, version] of Object.entries(dependencies)) {
        const manifest = {
          name,
          version,
          peerDependencies:
            name === 'plugin' ? peers : name === 'react-dom' ? { react: '^18' } : {},
        };
        mkdirSync(join(cwd, 'node_modules', name), { recursive: true });
        writeFileSync(join(cwd, 'node_modules', name, 'package.json'), JSON.stringify(manifest));
        packages[`node_modules/${name}`] = manifest;
      }
      writeFileSync(
        join(cwd, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages }),
      );
      writeFileSync(
        join(cwd, '.npmrc'),
        `registry=http://127.0.0.1:${(server.address() as AddressInfo).port}\n`,
      );
      writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-qm',
          'fixture',
        ],
      ])
        execFileSync('git', args, { cwd });
      const result = await promisify(execFile)(
        process.execPath,
        [bin, 'fix', 'react', '--target', '19.3.0', '--no-llm', '--json'],
        {
          cwd,
          timeout: 10000,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
            ),
            NPM_CONFIG_USERCONFIG: '/nonexistent',
            UPTIDE_TELEMETRY: '0',
            UPTIDE_CACHE_DIR: join(cwd, 'cache'),
          },
        },
      ).then(
        (output) => ({ ...output, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.code).toBe(2);
      const report = JSON.parse(result.stdout);
      expect(report.peerConflicts).toEqual([
        {
          name: 'plugin',
          version: '1.0.0',
          newer: '1.1.0',
          allowed: false,
          peers: ['react', 'react-dom'].map((peer) => ({
            peer,
            range: '^18',
            target: '19.3.0',
            version: '1.0.0',
          })),
        },
      ]);
      expect(report.next).toBe('npx uptide fix react plugin --target 19.3.0 --no-llm');
      expect(report.error.code).toBe('INCONSISTENT_UPGRADE');
      expect(result.stderr).not.toContain('error:');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
