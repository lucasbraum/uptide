import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UptideError } from '../../errors.js';
export type ManagerKind = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry';
export interface PackageManager {
  kind: ManagerKind;
  bin: string;
  lockfile: string;
  args: string[];
  env?: Record<string, string>;
  requestedVersion?: string;
  /** Why this manager, when the repository could have meant another: other lockfiles present. */
  chosen?: string;
}
const LOCKFILES: [string, 'pnpm' | 'npm' | 'yarn'][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
];
/**
 * Which manager the repository means: `packageManager` in package.json first (that is what
 * corepack runs), else the one lockfile present, else the first by precedence. Several
 * lockfiles are named with the choice, and the others are never written.
 */
export function chooseManager(
  root: string,
  declared: string,
): { name: 'pnpm' | 'npm' | 'yarn'; lockfile: string; chosen?: string } | undefined {
  const present = LOCKFILES.filter(([file]) => existsSync(join(root, file)));
  const declaredName = declared.split('@')[0];
  const byDeclaration = present.find(([, name]) => name === declaredName);
  const pick = byDeclaration ?? present[0];
  if (!pick) return undefined;
  const others = present.filter((p) => p !== pick).map(([file]) => file);
  const chosen = others.length
    ? `${pick[0]} (${byDeclaration ? `packageManager says ${declaredName}` : `first by precedence: pnpm, npm, yarn`}); ${others.join(', ')} left untouched`
    : undefined;
  return { name: pick[1], lockfile: pick[0], ...(chosen ? { chosen } : {}) };
}
export function berrySkipBuild(major: number): string {
  return major < 3 ? '--skip-builds' : major < 4 ? '--mode=skip-builds' : '--mode=skip-build';
}
export function packageManager(root: string): PackageManager {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared: string = manifest.packageManager ?? '';
  const requestedVersion = declared.split('@')[1]?.split('+')[0];
  const locked = (file: string) => existsSync(join(root, file));
  const choice = chooseManager(root, declared);
  const base = {
    ...(requestedVersion ? { requestedVersion } : {}),
    ...(choice?.chosen ? { chosen: choice.chosen } : {}),
  };
  if (choice?.name === 'pnpm')
    return {
      ...base,
      kind: 'pnpm',
      bin: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      args: ['install', '--ignore-scripts', '--frozen-lockfile'],
    };
  const npm = choice?.name === 'npm' ? choice.lockfile : undefined;
  if (npm) {
    const version = JSON.parse(readFileSync(join(root, npm), 'utf8')).lockfileVersion;
    if (![2, 3].includes(version))
      throw new UptideError('UNSUPPORTED_LOCKFILE', 'npm fix requires lockfileVersion 2 or 3');
    return {
      ...base,
      kind: 'npm',
      bin: 'npm',
      lockfile: npm,
      args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    };
  }
  if (choice?.name === 'yarn') {
    const berry =
      locked('.yarnrc.yml') ||
      /^__metadata:/m.test(readFileSync(join(root, 'yarn.lock'), 'utf8')) ||
      /^yarn@[2-9]/.test(declared);
    return {
      ...base,
      kind: berry ? 'yarn-berry' : 'yarn-classic',
      bin: 'yarn',
      lockfile: 'yarn.lock',
      args: berry
        ? ['install', '--immutable', berrySkipBuild(Number(requestedVersion?.split('.')[0] ?? 4))]
        : ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
      env: {
        YARN_ENABLE_SCRIPTS: 'false',
        YARN_ENABLE_TELEMETRY: '0',
        COREPACK_ENABLE_AUTO_PIN: '0',
      },
    };
  }
  throw new UptideError(
    'UNSUPPORTED_PACKAGE_MANAGER',
    'fix supports npm (lockfile v2/v3), pnpm, and Yarn classic/Berry; no supported lockfile found',
  );
}
/** Manifests have already been updated, so npm can preserve dependency sections with no add/save flags. */
export function updateArgs(pm: PackageManager, root: string, workspaces: string[]): string[] {
  switch (pm.kind) {
    case 'npm': {
      const version = JSON.parse(readFileSync(join(root, pm.lockfile), 'utf8')).lockfileVersion;
      const children = workspaces.filter((w) => w !== '.');
      return [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `--lockfile-version=${version}`,
        ...children.flatMap((w) => ['-w', w]),
        ...(children.length && workspaces.includes('.') ? ['--include-workspace-root'] : []),
      ];
    }
    case 'pnpm':
      return ['install', '--ignore-scripts', '--no-frozen-lockfile', '--prefer-offline'];
    case 'yarn-classic':
      return ['install', '--ignore-scripts', '--non-interactive'];
    case 'yarn-berry':
      return [
        'install',
        pm.args.find((a) => a.startsWith('--mode=') || a === '--skip-builds') ??
          '--mode=skip-build',
      ];
  }
}
