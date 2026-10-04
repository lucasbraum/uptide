/** pnpm eval:fix <repo> [--only=zod|stripe] [--target=package@version] [--without-key|--with-key] [--include-deprecated] [--provider=anthropic|openai|gemini] [--model=id] */

import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fix, formatFix, KEY_ENV, selectLlm } from '@uptide/core';
import { workspacePackagesOf } from '../packages/core/src/adapters/typescript/repo.ts';

const args = process.argv.slice(2);
const source = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const only = args.find((a) => a.startsWith('--only='))?.slice(7) ?? 'zod';
if (only !== 'zod' && only !== 'stripe') throw new Error('--only must be zod or stripe');
const selected = selectLlm(source, {
  provider: args.find((a) => a.startsWith('--provider='))?.slice(11),
  model: args.find((a) => a.startsWith('--model='))?.slice(8),
});
const withKey = args.includes('--with-key');
const withoutKey = args.includes('--without-key');
const mode = withoutKey ? 'without-key' : withKey ? 'with-key' : 'auto';
const publish = args.includes('--pr');
const out = resolve(
  'eval-out',
  `${basename(source)}-${only}-${mode}-${selected.provider}-${selected.model.replaceAll('/', '_')}`,
);
mkdirSync(out, { recursive: true });
if (withKey && !selected.available) {
  const text = `Agent eval not run: ${KEY_ENV[selected.provider]} is not set. No API request made; no token/cost result available.\n`;
  console.log(text);
  writeFileSync(join(out, 'output.txt'), text);
  process.exitCode = 2;
} else {
  const parent = mkdtempSync(join(tmpdir(), 'uptide-eval-fix-'));
  const worktree = join(parent, 'repo');
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', ...a], {
      encoding: 'utf8',
    }).trim();
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain');
  git('worktree', 'add', '--detach', worktree, head);
  console.log(`Temporary worktree: ${worktree}`);
  // Copy, never symlink, the installed dependency tree. All install writes remain in the worktree.
  for (const workspace of workspacePackagesOf(source)) {
    const modules = join(source, workspace, 'node_modules');
    if (existsSync(modules))
      cpSync(modules, join(worktree, workspace, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
  }
  const start = Date.now();
  try {
    const report = await fix({
      cwd: worktree,
      provider: selected.provider,
      model: selected.model,
      only,
      pr: publish,
      yes: args.includes('--yes'),
      target: args.find((a) => a.startsWith('--target='))?.slice(9),
      includeDeprecated: args.includes('--include-deprecated'),
      ...(withoutKey ? { fixer: null } : {}),
    });
    const output = `Source: ${basename(source)} @ ${head.slice(0, 8)}\nMode: ${mode}\n${formatFix(report)}Eval total: ${((Date.now() - start) / 1000).toFixed(2)}s\n`;
    console.log(output);
    writeFileSync(join(out, 'output.txt'), output);
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
    cpSync(report.prBody, join(out, 'pr-body.md'));
    // Keep the worktree reviewable, freeing the command's standard branch name for the next eval.
    if (!report.prUrl)
      execFileSync('git', [
        '-C',
        worktree,
        'branch',
        '-m',
        `codex/eval-${only}-${mode}-${Date.now()}`,
      ]);
  } catch (e) {
    const message = `Eval failed: ${e instanceof Error ? e.message : String(e)}\nWorktree retained: ${worktree}\n`;
    console.error(message);
    writeFileSync(join(out, 'output.txt'), message);
    process.exitCode = 1;
  } finally {
    if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain') !== status) {
      console.error('source repository changed during eval');
      process.exitCode = 1;
    }
  }
}
