import { createInterface } from 'node:readline';

/** Everything the CLI touches outside its own process state, so tests can run it in memory. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** stdout is a terminal: color is on unless something turns it off. */
  outTty: boolean;
  columns?: number;
  /** stderr is a terminal: progress may redraw one line. */
  errTty: boolean;
  now(): number;
  inTty?: boolean;
  confirmTelemetry?: () => Promise<boolean>;
}

export function processIo(): Io {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    outTty: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    errTty: process.stderr.isTTY === true,
    now: () => Date.now(),
    inTty: process.stdin.isTTY === true,
    confirmTelemetry: () =>
      new Promise<boolean>((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
          terminal: true,
        });
        let settled = false;
        const done = (yes: boolean): void => {
          if (settled) return;
          settled = true;
          rl.close();
          resolve(yes);
        };
        rl.on('SIGINT', () => done(false));
        rl.on('close', () => done(false));
        rl.question(
          'Share anonymous CLI usage with Uptide (PostHog EU, 90-day retention)?\nRandom IDs, public package versions and aggregate counts only; no IP, code, paths or repo names.\nDetails: https://github.com/uptide-dev/uptide/blob/main/docs/telemetry.md\nEnable telemetry? [y/N] ',
          (answer) => done(/^y(?:es)?$/i.test(answer.trim())),
        );
      }),
  };
}

export interface UiFlags {
  ci?: boolean;
  /** commander's `--no-color` sets this to false. */
  color?: boolean;
}

export interface Ui {
  color: boolean;
  /** One redrawn line with a spinner; off in CI, in pipes and with NO_COLOR-style plain output. */
  interactive: boolean;
}

/**
 * `--ci` (or a `CI` environment) means plain lines only. NO_COLOR follows no-color.org: any
 * non-empty value disables color; FORCE_COLOR turns it on for a pipe.
 */
export function uiOf(io: Io, flags: UiFlags): Ui {
  const ci =
    flags.ci === true || (io.env.CI !== undefined && io.env.CI !== '' && io.env.CI !== '0');
  const noColor = io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== '';
  const forced = io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== '0';
  const color = !ci && flags.color !== false && !noColor && (io.outTty || forced);
  return { color, interactive: !ci && io.outTty && io.errTty && io.env.TERM !== 'dumb' };
}
