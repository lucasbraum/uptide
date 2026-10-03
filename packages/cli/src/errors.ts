import {
  IntegrityError,
  NoTypesError,
  PackageNotFoundError,
  VersionNotFoundError,
} from '@uptide/core';
import pc from 'picocolors';

/** Exit codes are the contract with scripts and CI: 0 nothing breaking, 1 breaking found, 2 the tool could not answer. */
export const EXIT = { ok: 0, breaking: 1, error: 2 } as const;

/** A failure the user can act on. `next` is the exact command to run, when there is one. */
export class CliError extends Error {
  override readonly name = 'CliError';
  constructor(
    message: string,
    readonly options: { why?: string; next?: string; exitCode?: number } = {},
  ) {
    super(message);
  }
}

/** Engine errors in the words the CLI has always used for them. */
export function explain(err: unknown): string {
  if (err instanceof NoTypesError)
    return `${err.packageName}@${err.version}: no type declarations, cannot analyze`;
  if (err instanceof VersionNotFoundError) {
    const hint = err.available.length > 0 ? ` (latest published: ${err.available.at(-1)})` : '';
    return `${err.message}${hint}`;
  }
  if (err instanceof PackageNotFoundError || err instanceof IntegrityError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function renderError(err: unknown, color: boolean): string {
  const colors = pc.createColors(color);
  const lines = [`${colors.red('error:')} ${explain(err)}`];
  if (err instanceof CliError) {
    if (err.options.why) lines.push(`  ${err.options.why}`);
    if (err.options.next) lines.push(`  ${colors.bold('Next:')} ${err.options.next}`);
  }
  return `${lines.join('\n')}\n`;
}
