import type { Change, Severity } from '../domain/change.js';
import type { Usage } from '../domain/usage.js';

/**
 * Pure. The direction table from docs/architecture.md: milestone 1 deferred some
 * severities because it could not see which side of the contract the consumer is on.
 * Returns the resolved severity and the reason, or undefined when the change's own
 * severity stands.
 */
export function resolveDirection(
  change: Change,
  usage: Usage,
): { severity: Severity; reason: string } | undefined {
  const { access } = usage;
  const consumes = access === 'read' || access === 'typeRef';
  const supplies = access === 'write' || access === 'call' || access === 'construct';

  switch (change.kind) {
    case 'widened':
      if (consumes) return { severity: 'breaking', reason: 'widened type is read by the consumer' };
      if (supplies)
        return {
          severity: 'additive',
          reason: 'widened type only receives values from the consumer',
        };
      return undefined;
    case 'narrowed':
      if (consumes)
        return { severity: 'additive', reason: 'narrower value still satisfies the reader' };
      if (supplies) return { severity: 'breaking', reason: "consumer's values may no longer fit" };
      return undefined;
    case 'required':
      // A member that became required.
      if (access === 'write' || access === 'construct')
        return { severity: 'breaking', reason: 'consumer must now supply the member' };
      if (access === 'implement')
        return { severity: 'breaking', reason: 'implementation must now provide the member' };
      if (access === 'read')
        return { severity: 'additive', reason: 'the member is now always present' };
      return undefined;
    case 'signature': {
      const notes = change.notes ?? '';
      const parameterRequired =
        /parameter '[^']+' became required|required parameter '[^']+' added/.test(notes);
      const parameterWidened = /parameter '[^']+' type widened/.test(notes);
      const parameterNarrowed = /parameter '[^']+' type narrowed/.test(notes);
      const parameterAddedOptional = /optional parameter '[^']+' added/.test(notes);
      const parameterRemoved = /parameter '[^']+' removed/.test(notes);
      if (access === 'implement') {
        // The consumer is on the other side of the contract: inputs flow in, not out.
        if (parameterRequired)
          return {
            severity: 'additive',
            reason: 'implementation now always receives the argument',
          };
        if (parameterWidened)
          return { severity: 'breaking', reason: 'implementation must accept more' };
        if (parameterNarrowed)
          return { severity: 'additive', reason: 'implementation receives a narrower argument' };
        if (parameterAddedOptional)
          return { severity: 'additive', reason: 'implementation may ignore extra arguments' };
        if (parameterRemoved)
          return {
            severity: 'breaking',
            reason: 'implementation must not expect the missing argument',
          };
        return undefined;
      }
      if (parameterRequired && (access === 'call' || access === 'construct')) {
        return { severity: 'breaking', reason: 'caller must now supply the argument' };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
