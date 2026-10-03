import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { generateClients } from './generate.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-generate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("runs the repository's own prisma generate where a schema is, with no database, and reports it", async () => {
  const root = join(scratch, 'repo');
  mkdirSync(join(root, 'packages/core/prisma'), { recursive: true });
  mkdirSync(join(root, 'packages/plain'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'packages/core/package.json'), '{"name":"core"}');
  writeFileSync(
    join(root, 'packages/core/prisma/schema.prisma'),
    'generator client { provider = "prisma-client-js" }',
  );
  writeFileSync(join(root, 'packages/plain/package.json'), '{"name":"plain"}');
  // A stand-in for the binary: records how it was called and where.
  const bin = join(root, 'node_modules/.bin/prisma');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "cwd=$(pwd) args=$* checkpoint=$CHECKPOINT_DISABLE" > "${root}/called.txt"\necho generated\n`,
  );
  chmodSync(bin, 0o755);
  const generated = await generateClients(root, ['packages/core', 'packages/plain']);
  expect(generated).toEqual([
    {
      workspace: 'packages/core',
      command: 'prisma generate --schema prisma/schema.prisma',
      status: 'generated',
    },
  ]);
  const called = readFileSync(join(root, 'called.txt'), 'utf8');
  expect(called).toContain('args=generate --schema prisma/schema.prisma');
  expect(called).toContain('checkpoint=1');
  expect(called).toMatch(/cwd=.*packages\/core/);
  // A failing generator is reported, never fatal.
  writeFileSync(bin, '#!/bin/sh\necho "schema error" >&2\nexit 1\n');
  expect(await generateClients(root, ['packages/core'])).toMatchObject([
    { status: 'failed', output: expect.stringContaining('schema error') },
  ]);
});
