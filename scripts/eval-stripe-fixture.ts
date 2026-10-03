/** Independent ground truth: real tsc before/after an install, never executes the consumer. */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command, git } from '../packages/core/src/fix/process.ts';
import { bumpVersions, install } from '../packages/core/src/fix/versions.ts';

const root = mkdtempSync(join(tmpdir(), 'uptide-stripe-fixture-'));
cpSync(resolve('fixtures/repos/stripe-consumer'), root, { recursive: true });
await install(root);
git(root, 'init');
git(root, 'config', 'user.name', 'Uptide fixture');
git(root, 'config', 'user.email', 'fixture@example.test');
git(root, 'add', '.');
git(root, 'commit', '-m', 'stripe 14 baseline');
const baseline = await command(root, 'pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']);
if (baseline.code) throw new Error(`baseline does not compile: ${baseline.output}`);
bumpVersions(root, 'stripe', '22.6.2');
await install(root);
const target = await command(root, 'pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']);
const errors = [...target.output.matchAll(/^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/gm)].map(
  (m) => ({ file: m[1], line: Number(m[2]), code: Number(m[4]), message: m[5] }),
);
if (target.timeout || errors.length === 0)
  throw new Error(`no reliable target errors: ${target.output}`);
const truth = { from: '14.25.0', to: '22.6.2', baselineErrors: 0, errors };
const output = `Stripe fixture: 14.25.0 → 22.6.2\nBaseline tsc: PASS (0 errors)\nTarget tsc: ${errors.length} errors\n${target.output}\nFixture repo: ${root}\n`;
mkdirSync('eval-out/stripe-fixture', { recursive: true });
writeFileSync('eval-out/stripe-fixture/output.txt', output);
writeFileSync('eval-out/stripe-fixture/truth.json', `${JSON.stringify(truth, null, 2)}\n`);
console.log(output);
// Preserve baseline lockfile in the checked-in fixture so eval:fix can bootstrap this consumer too.
writeFileSync(
  'fixtures/repos/stripe-consumer/pnpm-lock.yaml',
  `${git(root, 'show', 'HEAD:pnpm-lock.yaml')}\n`,
);
writeFileSync(
  'fixtures/repos/stripe-consumer/ground-truth.json',
  `${JSON.stringify(truth, null, 2)}\n`,
);
