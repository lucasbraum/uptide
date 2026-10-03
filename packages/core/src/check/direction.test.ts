import { describe, expect, it } from 'vitest';
import type { Change } from '../domain/change.js';
import type { Usage, UsageAccess } from '../domain/usage.js';
import { resolveDirection } from './direction.js';

const change = (
  c: Partial<Change> & { kind: Change['kind']; severity: Change['severity'] },
): Change => ({
  package: 'p',
  from: '1',
  to: '2',
  path: 'X#m',
  source: 'types',
  confidence: 1,
  ...c,
});
const usage = (access: UsageAccess): Usage => ({
  file: 'a.ts',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  symbolPath: 'X#m',
  access,
  snippet: '',
  via: 'direct',
});

/** One row of the table in docs/architecture.md per case. */
describe('resolveDirection', () => {
  const widened = change({ kind: 'widened', severity: 'additive' });
  const narrowed = change({ kind: 'narrowed', severity: 'breaking' });
  const requiredMember = change({ kind: 'required', severity: 'breaking' });
  const requiredParam = change({
    kind: 'signature',
    severity: 'breaking',
    notes: "parameter 'opts' became required",
  });
  const widenedParam = change({
    kind: 'signature',
    severity: 'additive',
    notes: "parameter 'e' type widened",
  });
  const narrowedParam = change({
    kind: 'signature',
    severity: 'breaking',
    notes: "parameter 'e' type narrowed",
  });
  const optionalParamAdded = change({
    kind: 'signature',
    severity: 'additive',
    notes: "optional parameter 'x' added",
  });
  const paramRemoved = change({
    kind: 'signature',
    severity: 'breaking',
    notes: "parameter 'x' removed",
  });

  it.each<[string, Change, UsageAccess, string | undefined]>([
    ['widened + read', widened, 'read', 'breaking'],
    ['widened + typeRef', widened, 'typeRef', 'breaking'],
    ['widened + write', widened, 'write', 'additive'],
    ['widened + call', widened, 'call', 'additive'],
    ['narrowed + read', narrowed, 'read', 'additive'],
    ['narrowed + write', narrowed, 'write', 'breaking'],
    ['narrowed + construct', narrowed, 'construct', 'breaking'],
    ['required param + call', requiredParam, 'call', 'breaking'],
    ['required param + implement', requiredParam, 'implement', 'additive'],
    ['required property + write', requiredMember, 'write', 'breaking'],
    ['required property + construct', requiredMember, 'construct', 'breaking'],
    ['required property + implement', requiredMember, 'implement', 'breaking'],
    ['required property + read', requiredMember, 'read', 'additive'],
    ['widened param + implement', widenedParam, 'implement', 'breaking'],
    ['narrowed param + implement', narrowedParam, 'implement', 'additive'],
    ['optional param added + implement', optionalParamAdded, 'implement', 'additive'],
    ['param removed + implement', paramRemoved, 'implement', 'breaking'],
    ['widened + import (unknown direction)', widened, 'import', undefined],
    [
      'removed + read (severity stands)',
      change({ kind: 'removed', severity: 'breaking' }),
      'read',
      undefined,
    ],
  ])('%s', (_name, c, access, expected) => {
    const resolved = resolveDirection(c, usage(access));
    expect(resolved?.severity).toBe(expected);
    if (expected !== undefined) expect(resolved?.reason).toBeTruthy();
  });
});
