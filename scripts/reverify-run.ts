/** Re-check a stored, commit-bound run without migrations, installs or source writes. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { behaviorCheck } from '../packages/core/src/fix/behavior.js';
import { retainedDiffs } from '../packages/core/src/fix/pr-body.js';
import { git } from '../packages/core/src/fix/process.js';
import { prBody } from '../packages/core/src/fix/report.js';
import type { FixDiagnostic, FixReport } from '../packages/core/src/fix/types.js';
import { diagnostics, newDiagnostics, testWorkspaces } from '../packages/core/src/fix/verify.js';
import { uptideVersionInfo } from '../packages/core/src/version.js';

const [input, output] = process.argv.slice(2);
if (!input) throw new Error('usage: tsx scripts/reverify-run.ts <stored-run.json> [output.json]');
const stored = JSON.parse(readFileSync(resolve(input), 'utf8')) as FixReport;
if (!stored.head) throw new Error('the stored run must be bound to the expected PR commit');
const root = stored.repo;
if (git(root, 'rev-parse', 'HEAD') !== stored.head)
  throw new Error('checkout differs from the stored PR commit');
if (git(root, 'diff', 'HEAD')) throw new Error('tracked source differs from the stored PR commit');
const untracked = () =>
  git(root, 'ls-files', '--others', '--exclude-standard')
    .split('\n')
    .filter((f) => f && !f.startsWith('.uptide/'))
    .join('\n');
const startUntracked = untracked();
if (startUntracked) throw new Error('unexpected untracked source in the PR checkout');
const report = retainedDiffs(stored);
const workspaces = [...new Set(stored.verification.tests.map((t) => t.workspace))];
if (!workspaces.length) throw new Error('no affected workspaces recorded in the stored run');
const started = Date.now();
const bump = git(root, 'log', '--format=%H%x09%s', stored.head)
  .split('\n')
  .find((line) => line.endsWith(`\tchore: upgrade ${stored.package} to ${stored.target}`))
  ?.split('\t')[0];
if (!bump) throw new Error('cannot locate the migration baseline in retained history');
const originals = new Map<string, string>();
for (const site of report.sites) {
  const file = site.finding.usage.file;
  if (!originals.has(file)) originals.set(file, git(root, 'show', `${bump}^:${file}`));
}
const tool = uptideVersionInfo();
report.behavior =
  stored.package === 'zod' ? behaviorCheck(root, originals, report.sites) : undefined;
const errors = new Map<string, FixDiagnostic>();
report.verification.workspaceTypes = workspaces.map((workspace) => {
  const found = diagnostics(root, [workspace]);
  for (const d of found) errors.set(`${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`, d);
  return { workspace, errors: found.length };
});
report.verification.after = [...errors.values()];
report.verification.newErrors = newDiagnostics(
  report.verification.baseline,
  report.verification.after,
);
report.verification.tests = await testWorkspaces(root, workspaces);
if (
  git(root, 'rev-parse', 'HEAD') !== stored.head ||
  git(root, 'diff', 'HEAD') ||
  untracked() !== startUntracked
)
  throw new Error('verification changed the PR checkout');
report.verification.passed =
  report.verification.newErrors.length === 0 &&
  report.verification.tests.every((t) => ['passed', 'missing'].includes(t.status));
Object.assign(report, tool, {
  verifiedAt: new Date().toISOString(),
  verificationTimingMs: Date.now() - started,
});
report.notes = report.notes.filter((n) => !n.startsWith('Behavior and type verification repeated'));
const destination = resolve(output ?? input);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
mkdirSync(dirname(report.prBody), { recursive: true });
writeFileSync(report.prBody, prBody(report));
writeFileSync(join(root, '.uptide/report.json'), `${JSON.stringify(report, null, 2)}\n`);
const schemas = (report.behavior ?? []).filter((b) => b.schema !== '(reported site)');
const checks = schemas.flatMap((b) => b.messageChecks ?? []).filter((c) => c.status !== 'default');
console.log(
  JSON.stringify(
    {
      run: destination,
      head: report.head,
      sourceUnchanged: true,
      schemas: schemas.length,
      inputs: schemas.reduce((n, b) => n + b.inputs, 0),
      identical: schemas.reduce((n, b) => n + b.identical, 0),
      customMessages: checks.filter((c) => c.status === 'identical').length,
      customMessageAssertions: checks.length,
      unchecked: schemas.filter((b) => b.skipped).map((b) => b.schema),
      types: report.verification.workspaceTypes,
      passed: report.verification.passed,
      ...tool,
    },
    null,
    2,
  ),
);
