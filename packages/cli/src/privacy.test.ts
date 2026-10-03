import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { PRIVACY } from './privacy.js';
import { fakeEngine, memoryIo, pnpmGitRepo } from './test-utils.js';

// The CLI's fix job is the isolated one: it runs in a private clone of the repository.
const core = vi.hoisted(() => ({ fix: vi.fn(async () => ({})), check: vi.fn(async () => ({})) }));
vi.mock('@uptide/core', async (original) => ({
  ...(await original<typeof import('@uptide/core')>()),
  isolatedFix: core.fix,
  check: core.check,
}));

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('privacy statement', () => {
  it('says the four things that matter', () => {
    const text = flat(PRIVACY);
    expect(text).toContain('Analysis runs locally.');
    expect(text).toContain('only for assisted fixes');
    expect(text).toContain('only with your own ANTHROPIC_API_KEY');
    expect(text).toContain('No telemetry, no account.');
  });

  it.each([[[]], [['fix']]])('is part of `uptide %s --help`', async (command) => {
    const io = memoryIo();
    expect(await run([...command, '--help'], io, fakeEngine())).toBe(0);
    expect(io.stdout()).toContain(PRIVACY);
  });

  it('is in the README, word for word', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const body = flat(PRIVACY.replace(/^Privacy:\n/, ''));
    expect(flat(readme)).toContain(body);
  });
});

describe('fix --no-llm', () => {
  it('is documented and reaches the engine as llm: false', async () => {
    const help = memoryIo();
    await run(['fix', '--help'], help, fakeEngine());
    expect(help.stdout()).toContain('--no-llm');

    const engine = fakeEngine();
    const io = memoryIo({ cwd: pnpmGitRepo(), env: { ANTHROPIC_API_KEY: 'test-key' } });
    expect(await run(['fix', '--only', 'zod', '--no-llm'], io, engine)).toBe(0);
    expect(engine.calls[0]).toMatchObject({ llm: false });
    expect(io.stderr()).toContain('assisted fixes off (--no-llm): no code leaves this machine');
    expect(io.stderr()).not.toContain('sent to Anthropic');
  });

  it('says so before anything is sent when assisted fixes are on', async () => {
    const engine = fakeEngine();
    const io = memoryIo({ cwd: pnpmGitRepo(), env: { ANTHROPIC_API_KEY: 'test-key' } });
    await run(['fix', '--only', 'zod'], io, engine);
    expect(engine.calls[0]).toMatchObject({ llm: true });
    expect(io.stderr()).toContain('note: assisted fixes are on.');
    expect(io.stderr()).toContain('Pass --no-llm to keep everything on this machine.');
  });

  it('gives the engine no fixer at all, even with a key in the environment', async () => {
    const { runJob } = await import('./jobs.js');
    const request = { cwd: '/repo', only: 'zod' as const };
    await runJob({ kind: 'fix', request: { ...request, llm: false } });
    expect(core.fix).toHaveBeenLastCalledWith({ ...request, fixer: null });
    await runJob({ kind: 'fix', request: { ...request, llm: true } });
    expect(core.fix).toHaveBeenLastCalledWith(request);
  });
});
