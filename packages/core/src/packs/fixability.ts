import type { Finding } from '../domain/report.js';
import type { MigrationPack } from './types.js';
/** Use the actual transform as a dry run, including its safety guards. */
export function packFixability(finding: Finding, source: string, pack: MigrationPack): Finding {
  if (!['breaking', 'unverified', 'deprecated'].includes(finding.severity)) return finding;
  const result = pack.transform(source, finding, {
    from: finding.change.from,
    to: finding.change.to,
    includeDeprecated: true,
  });
  return result.applied ? { ...finding, fixability: 'mechanical' } : finding;
}
