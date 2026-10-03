import type { Change } from '../domain/change.js';
import type { Fixability } from '../domain/report.js';
import type { Usage } from '../domain/usage.js';

const IDENTIFIER_OR_MEMBER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

/**
 * The replacement a deprecation message names, when it names exactly one bare identifier
 * or member: `{@link parse}`, `` `z.email()` ``, "use paymentMethods instead". Prose
 * that names several things, or none, is not mechanical.
 */
export function deprecationReplacement(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const candidates = new Set<string>();
  for (const m of notes.matchAll(/\{@link\s+([^}|\s]+)[^}]*\}/g)) candidates.add(m[1] as string);
  for (const m of notes.matchAll(/`([^`]+)`/g)) candidates.add(m[1] as string);
  if (candidates.size === 0) {
    const m = /\buse\s+([A-Za-z_$][\w$.]*(?:\(\))?)\s+instead/i.exec(notes);
    if (m) candidates.add(m[1] as string);
  }
  const valid = [...candidates].filter((c) => IDENTIFIER_OR_MEMBER.test(c));
  return valid.length === 1 ? valid[0] : undefined;
}

const ONLY_PARAM_REMOVED = /^(parameter '[^']+' removed)(; parameter '[^']+' removed)*$/;

/** Pure. The fixability table from docs/architecture.md. */
export function fixabilityOf(
  change: Change,
  usage: Usage,
  severity: Change['severity'],
): Fixability {
  if (severity === 'additive' || severity === 'info') return 'none';
  if (usage.via === 'inferred') return 'unknown';
  switch (change.kind) {
    case 'moved':
    case 'renamed':
      return 'mechanical';
    case 'removed':
      return change.replacement !== undefined ? 'mechanical' : 'manual';
    case 'deprecated':
      return deprecationReplacement(change.notes) !== undefined ? 'mechanical' : 'manual';
    case 'signature':
      if (change.notes !== undefined && ONLY_PARAM_REMOVED.test(change.notes)) return 'mechanical';
      return 'assisted';
    case 'required':
    case 'type':
    case 'widened':
    case 'narrowed':
    case 'module-format':
      return 'assisted';
    default:
      return 'manual';
  }
}
