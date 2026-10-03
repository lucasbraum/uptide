import { UptideError } from '../../errors.js';
import { command } from '../process.js';
import { berrySkipBuild, type PackageManager, packageManager } from './manager.js';

export function repairCommand(pm: PackageManager): string {
  const wanted =
    pm.requestedVersion ??
    (pm.kind === 'yarn-classic' ? '1.22.22' : pm.kind === 'yarn-berry' ? 'stable' : 'latest');
  return `corepack enable ${pm.bin} && corepack prepare ${pm.bin}@${wanted} --activate`;
}
export async function assertManagerAvailable(
  root: string,
  probe = command,
): Promise<PackageManager> {
  const pm = packageManager(root);
  const result = await probe(root, pm.bin, ['--version'], 15000, {
    ...pm.env,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  });
  const next = repairCommand(pm);
  if (result.code)
    throw new UptideError(
      'PACKAGE_MANAGER_UNAVAILABLE',
      `${pm.bin}${pm.requestedVersion ? `@${pm.requestedVersion}` : ''} is not available in this environment. Enable Corepack and activate the repository's package manager.\nNext: ${next}`,
    );
  const actual = result.output.trim().split('\n').at(-1) ?? '';
  const major = Number(/^(\d+)\./.exec(actual)?.[1]);
  const family =
    pm.kind === 'yarn-classic'
      ? major === 1
      : pm.kind === 'yarn-berry'
        ? major >= 2
        : pm.kind === 'npm'
          ? major >= 7
          : major >= 7;
  if (!family || (pm.requestedVersion && actual !== pm.requestedVersion))
    throw new UptideError(
      'PACKAGE_MANAGER_VERSION',
      `Found ${pm.bin}@${actual || 'unknown'}, but this repository requires ${pm.requestedVersion ? `${pm.bin}@${pm.requestedVersion}` : pm.kind}. No files were installed.\nNext: ${next}`,
    );
  if (pm.kind === 'yarn-berry')
    pm.args = pm.args.map((a) =>
      a.startsWith('--mode=') || a === '--skip-builds' ? berrySkipBuild(major) : a,
    );
  return pm;
}
