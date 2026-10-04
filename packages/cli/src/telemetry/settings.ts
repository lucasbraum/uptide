import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings {
  consent: boolean;
  installId?: string;
  salt?: string;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;

export function settingsPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'uptide', 'telemetry.json');
}

/** Unreadable/corrupt preferences fail closed and do not repeatedly prompt. */
export function readSettings(path: string): Settings | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return {
      consent: value.consent === true,
      ...(UUID.test(value.installId) ? { installId: value.installId } : {}),
      ...(HASH.test(value.salt) ? { salt: value.salt } : {}),
    };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { consent: false };
  }
}

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function identity(settings: Settings): Required<Settings> {
  return {
    consent: settings.consent,
    installId: settings.installId ?? randomUUID(),
    salt: settings.salt ?? randomBytes(32).toString('hex'),
  };
}

export function enabled(
  settings: Settings | undefined,
  env: NodeJS.ProcessEnv,
  ci: boolean,
): boolean {
  if (env.UPTIDE_TELEMETRY === '0') return false;
  if (env.UPTIDE_TELEMETRY === '1') return true;
  return !ci && settings?.consent === true;
}

export function isCi(env: NodeJS.ProcessEnv, flag = false): boolean {
  return (
    flag ||
    (!!env.CI && env.CI !== '0') ||
    env.GITHUB_ACTIONS === 'true' ||
    env.GITLAB_CI === 'true' ||
    env.TF_BUILD === 'True'
  );
}
