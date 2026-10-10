import type { ProgressEvent } from '@uptide/core';
import pc from 'picocolors';
import type { Io, Ui } from './io.js';

/** `850ms`, `4.2s`, `48s`, `1m 05s`: short enough to end every phase line. */
export function elapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Without a terminal there is no spinner; a long phase says it is alive this often. */
export const HEARTBEAT_MS = 10_000;

export interface Progress {
  event(event: ProgressEvent): void;
  /**
   * Run one phase. It ends with exactly one line on stderr, `✔ label  detail (4.2s)`, or
   * `✖ label (4.2s)` when it throws. While it runs, a terminal shows a spinner with the
   * running time and anything else gets a line every ten seconds: never a silent minute.
   * In quiet mode only the spinner and a failure line exist.
   */
  phase<T>(label: string, work: () => Promise<T>, detail?: (result: T) => string): Promise<T>;
  /** An indented line under the last phase. */
  note(text: string): void;
}

export interface ProgressOptions {
  /**
   * One live line and nothing left behind: a terminal sees a spinner with the current phase
   * that disappears when the work ends; anything else sees no progress at all (the caller
   * prints a start line and the final timing). Failures are still reported.
   */
  quiet?: boolean;
}

export function createProgress(io: Io, ui: Ui, options: ProgressOptions = {}): Progress {
  const colors = pc.createColors(ui.color);
  const quiet = options.quiet === true;
  let activity = '';
  return {
    event(event) {
      // `verify · types (core, ui, worker)`: the phase and what exactly it is doing.
      const label = [event.phase, event.detail ?? event.package, event.workspace]
        .filter(Boolean)
        .join(' · ');
      if (event.warning) {
        if (ui.interactive) io.err('\r\x1b[2K');
        io.err(`  ${event.detail ?? label}\n`);
      } else if (event.state === 'start') activity = label;
      else if (quiet) activity = '';
      else {
        if (ui.interactive) io.err('\r\x1b[2K');
        io.err(`  ${label} (${elapsed(event.ms ?? 0)})\n`);
        activity = '';
      }
    },
    async phase(label, work, detail) {
      const started = io.now();
      const since = (): string => elapsed(io.now() - started);
      let frame = 0;
      const tick = ui.interactive
        ? setInterval(() => {
            frame = (frame + 1) % FRAMES.length;
            io.err(
              `\r\x1b[2K${colors.cyan(FRAMES[frame] ?? '')} ${activity || label} ${colors.dim(since())}`,
            );
          }, 80)
        : quiet
          ? undefined
          : setInterval(
              () => io.err(`… ${activity || label}, still working (${since()})\n`),
              HEARTBEAT_MS,
            );
      tick?.unref?.();
      if (ui.interactive) io.err(`${colors.cyan(FRAMES[0] ?? '')} ${label}`);
      const clear = (): void => {
        clearInterval(tick);
        if (ui.interactive) io.err('\r\x1b[2K');
      };
      try {
        const result = await work();
        clear();
        if (quiet) return result;
        const text = detail?.(result);
        io.err(
          `${colors.green('✔')} ${label}${text ? `  ${text}` : ''} ${colors.dim(`(${since()})`)}\n`,
        );
        return result;
      } catch (err) {
        clear();
        io.err(`${colors.red('✖')} ${label} ${colors.dim(`(${since()})`)}\n`);
        throw err;
      }
    },
    note(text) {
      if (quiet) return;
      io.err(`  ${colors.dim(text)}\n`);
    },
  };
}
