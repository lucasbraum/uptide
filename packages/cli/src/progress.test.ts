import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiOf } from './io.js';
import { createProgress, elapsed, HEARTBEAT_MS } from './progress.js';
import { ESC, memoryIo } from './test-utils.js';

afterEach(() => vi.useRealTimers());

describe('elapsed', () => {
  it('stays short at every scale', () => {
    expect(elapsed(42)).toBe('42ms');
    expect(elapsed(4234)).toBe('4.2s');
    expect(elapsed(48_400)).toBe('48s');
    expect(elapsed(65_000)).toBe('1m 05s');
  });
});

describe('progress', () => {
  it('keeps planning warnings visible in quiet mode', () => {
    const io = memoryIo();
    const progress = createProgress(io, uiOf(io, {}), { quiet: true });
    progress.event({
      phase: 'resolve',
      state: 'done',
      warning: true,
      detail: 'plugin rejects react 19',
    });
    expect(io.stderr()).toBe('  plugin rejects react 19\n');
  });

  it('ends a phase with one line carrying its detail and elapsed time', async () => {
    let clock = 0;
    const io = memoryIo({ now: () => clock });
    const progress = createProgress(io, uiOf(io, {}));
    const result = await progress.phase(
      'Repository',
      async () => {
        clock = 1500;
        return 'shop';
      },
      (name) => `${name} (npm)`,
    );
    expect(result).toBe('shop');
    expect(io.stderr()).toBe('✔ Repository  shop (npm) (1.5s)\n');
    expect(io.stdout()).toBe('');
  });

  it('says it is alive every ten seconds when there is no terminal', async () => {
    vi.useFakeTimers();
    const io = memoryIo({ now: () => Date.now() });
    const progress = createProgress(io, uiOf(io, {}));
    const phase = progress.phase('Analysis', () => new Promise((r) => setTimeout(r, 35_000)));
    await vi.advanceTimersByTimeAsync(35_000);
    await phase;
    const lines = io.stderr().trimEnd().split('\n');
    expect(lines).toEqual([
      '… Analysis, still working (10s)',
      '… Analysis, still working (20s)',
      '… Analysis, still working (30s)',
      '✔ Analysis (35s)',
    ]);
    expect(HEARTBEAT_MS).toBeLessThan(60_000);
  });

  it('redraws a spinner on a terminal and leaves only the final line behind', async () => {
    vi.useFakeTimers();
    const io = memoryIo({ errTty: true, outTty: true, now: () => Date.now() });
    const progress = createProgress(io, uiOf(io, {}));
    const phase = progress.phase('Analysis', () => new Promise((r) => setTimeout(r, 400)));
    await vi.advanceTimersByTimeAsync(400);
    await phase;
    expect(io.stderr()).toContain('\r\x1b[2K');
    expect(io.stderr().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('never redraws with --ci, even on a terminal', async () => {
    const io = memoryIo({ errTty: true, outTty: true });
    const ui = uiOf(io, { ci: true });
    await createProgress(io, ui).phase('Repository', async () => 1);
    expect(ui).toEqual({ color: false, interactive: false });
    expect(io.stderr()).not.toContain(ESC);
    expect(io.stderr()).not.toContain('\r');
  });

  it('quiet: a terminal sees one live line that disappears, with nothing left behind', async () => {
    vi.useFakeTimers();
    const io = memoryIo({ errTty: true, outTty: true, now: () => Date.now() });
    const progress = createProgress(io, uiOf(io, {}), { quiet: true });
    const phase = progress.phase(
      'Analysis',
      async () => {
        progress.event({ phase: 'usages', package: 'zod', state: 'start' });
        await new Promise((r) => setTimeout(r, 400));
        progress.event({ phase: 'usages', package: 'zod', state: 'done', ms: 400 });
        progress.note('zod: usages 400ms');
        return 1;
      },
      () => 'done',
    );
    await vi.advanceTimersByTimeAsync(400);
    await phase;
    // The spinner named the engine's current phase while it ran...
    expect(io.stderr()).toContain('usages · zod');
    // ...and the last thing written clears the line: no phase, detail or note line remains.
    expect(io.stderr()).not.toContain('\n');
    expect(io.stderr().endsWith('\r\x1b[2K')).toBe(true);
  });

  it('quiet: without a terminal nothing is printed, not even a heartbeat', async () => {
    vi.useFakeTimers();
    const io = memoryIo({ now: () => Date.now() });
    const progress = createProgress(io, uiOf(io, {}), { quiet: true });
    const phase = progress.phase('Analysis', () => new Promise((r) => setTimeout(r, 35_000)));
    progress.event({ phase: 'compile', package: 'zod', state: 'done', ms: 3 });
    await vi.advanceTimersByTimeAsync(35_000);
    await phase;
    expect(io.stderr()).toBe('');
  });

  it('quiet: a failed phase is still reported', async () => {
    const io = memoryIo();
    const progress = createProgress(io, uiOf(io, {}), { quiet: true });
    await expect(
      progress.phase('Analysis', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(io.stderr()).toMatch(/^✖ Analysis \(/);
  });

  it('marks a failed phase and rethrows', async () => {
    const io = memoryIo({ now: () => 0 });
    const progress = createProgress(io, uiOf(io, {}));
    await expect(
      progress.phase('Analysis', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(io.stderr()).toBe('✖ Analysis (0ms)\n');
  });
});

describe('uiOf', () => {
  const tty = { outTty: true, errTty: true };
  it('colors a terminal by default', () => {
    expect(uiOf(memoryIo(tty), {})).toEqual({ color: true, interactive: true });
  });
  it('respects NO_COLOR', () => {
    expect(uiOf(memoryIo({ ...tty, env: { NO_COLOR: '1' } }), {}).color).toBe(false);
    expect(uiOf(memoryIo({ ...tty, env: { NO_COLOR: '' } }), {}).color).toBe(true);
  });
  it('respects --no-color and a CI environment', () => {
    expect(uiOf(memoryIo(tty), { color: false }).color).toBe(false);
    expect(uiOf(memoryIo({ ...tty, env: { CI: 'true' } }), {})).toEqual({
      color: false,
      interactive: false,
    });
  });
  it('stays plain in a pipe unless FORCE_COLOR is set', () => {
    expect(uiOf(memoryIo(), {}).color).toBe(false);
    expect(uiOf(memoryIo({ env: { FORCE_COLOR: '1' } }), {}).color).toBe(true);
  });
});

it('prints engine phase timings on stderr with package and workspace context', () => {
  const io = memoryIo();
  const p = createProgress(io, uiOf(io, {}));
  p.event({ phase: 'compile', package: 'zod', workspace: 'packages/api', state: 'start' });
  p.event({ phase: 'compile', package: 'zod', workspace: 'packages/api', state: 'done', ms: 1500 });
  expect(io.stderr()).toBe('  compile · zod · packages/api (1.5s)\n');
  expect(io.stdout()).toBe('');
});
