import type { Finding, RuntimeReport, Tier } from '../domain/report.js';
import type { MigrationPack } from '../packs/types.js';
import { runtimeConfirms } from './file-kind.js';

/** The difference, in one line, wherever a tier is shown. */
export const TIER_LEGEND =
  'verified: migration pack · generic: no pack · in both, breaking only if the compiler, the runtime probe or the pack confirms it';

/**
 * `verified`: a migration pack covers this upgrade (rules, a guide, ground truth it is scored
 * against). `generic`: no pack; the analysis is the same, and only what the compiler or the
 * runtime probe confirms is called breaking.
 */
export function tierOf(
  packs: readonly MigrationPack[],
  name: string,
  installed: string,
  target: string,
): Tier {
  const pack = packs.find((candidate) => candidate.name === name);
  return pack?.supports(installed, target) ? 'verified' : 'generic';
}

/**
 * What stands behind a breaking finding, or undefined when nothing but the declaration diff
 * does:
 * - `compiler`: the repository's own program fails against the target at this site;
 * - `runtime`: loading the target in the sandboxed Node shows the export gone or changed;
 * - `module-format`: a `require()` site of a package whose target is ESM-only;
 * - `removed-export`: the site imports a name the target no longer exports;
 * - `pack`: a migration pack found it in the code (verified tier only).
 */
export function evidenceOf(
  f: Finding,
  runtime?: RuntimeReport,
  loadRoot?: string,
): Finding['evidence'] {
  if (f.change.source === 'pack') return 'pack';
  if (
    f.usage.compileError !== undefined ||
    /^TS\d+$/.test(f.change.path) ||
    f.change.path.startsWith('cause:')
  )
    return 'compiler';
  if (f.change.kind === 'module-format') return 'module-format';
  if (runtime && !runtime.inconclusive && runtimeConfirms(f.usage, runtime.changes, loadRoot))
    return 'runtime';
  // The import of a top-level name that is gone: the import statement is the evidence.
  if (
    (f.change.kind === 'removed' || f.change.kind === 'moved') &&
    f.usage.access === 'import' &&
    !/[.#[]/.test(f.change.path)
  )
    return 'removed-export';
  return undefined;
}

/**
 * Breaking means confirmed, in every tier: a finding is breaking only with evidence. The rest
 * is kept as `unverified`, the "possible impact" a report lists apart: the declarations
 * changed at a place the code uses, and nothing confirmed that the code breaks there. A pack's
 * own findings carry their evidence (`pack`); its rules claim compiler-confirmed sites as before.
 */
export function confirmBreaking(
  findings: Finding[],
  evidence: (f: Finding) => Finding['evidence'],
): Finding[] {
  return findings.map((f) => {
    const found = evidence(f);
    if (f.severity !== 'breaking') return found ? { ...f, evidence: found } : f;
    if (found) return { ...f, evidence: found };
    return {
      ...f,
      severity: 'unverified',
      reason: `${f.reason}; not confirmed by the compiler or the runtime probe`,
    };
  });
}
