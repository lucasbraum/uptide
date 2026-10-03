import type { SignatureComparison, TypeComparison, TypeRelation } from '../domain/adapter.js';
import type { Severity } from '../domain/change.js';
import { leafOf } from '../domain/path.js';
import type { ApiSurface, ApiSymbol } from '../domain/surface.js';
import type { UnclassifiedChange } from './classify.js';
import { asCallable, parseCallable, splitTopLevel } from './signature-parse.js';

/**
 * Pure. Replaces textual verdicts with assignability-based ones where the adapter could
 * resolve both sides. The question is always "who supplies the value": a caller supplies
 * arguments and receives returns; an implementer of a callback is the other way round; an
 * interface property may be either, so its direction is unknown.
 */

export const WIDENED_NOTE = 'type widened; breaking if the member is read by the consumer';

type Role = 'callable' | 'callback' | 'output' | 'unknown';

function hasOtherMembers(callPath: string, symbols: Map<string, ApiSymbol>): boolean {
  const container = callPath.slice(0, -'#()'.length);
  for (const path of symbols.keys()) {
    if (path === callPath || !path.startsWith(container) || path.length <= container.length)
      continue;
    const sep = path[container.length];
    if ((sep === '#' || sep === '.' || sep === '[') && path !== `${container}.new()`) return true;
  }
  return false;
}

function roleOf(
  symbol: ApiSymbol,
  comparison: TypeComparison,
  symbols: Map<string, ApiSymbol>,
): Role | undefined {
  switch (symbol.kind) {
    case 'function':
      return 'callable';
    case 'method':
      // An interface that is nothing but a call signature (AxiosAdapter, a transformer) is a
      // function type the consumer implements; one with members (AxiosInstance) is called.
      return leafOf(symbol.path) === '()' && !hasOtherMembers(symbol.path, symbols)
        ? 'callback'
        : 'callable';
    case 'property':
      // A function-typed property is a callback the consumer implements when it is optional
      // or named like an event hook; otherwise it is something the consumer calls
      // (`axios.isAxiosError`, `Static#all`).
      if (comparison.callable)
        return symbol.optional || /^on[A-Z]/.test(leafOf(symbol.path)) ? 'callback' : 'callable';
      return symbol.signature.startsWith('readonly ') ? 'output' : 'unknown';
    case 'variable':
    case 'enumMember':
    case 'class':
      return 'output';
    case 'interface':
    case 'type':
      return 'unknown';
    default:
      return undefined;
  }
}

interface Verdict {
  severity: Severity;
  confidence: number;
  notes: string[];
}

/** Collects every reason; severity is breaking when any reason is. */
function collect(): {
  verdict: Verdict;
  breaking: (note: string) => void;
  additive: (note: string, confidence?: number) => void;
} {
  const breakingNotes: string[] = [];
  const additiveNotes: string[] = [];
  const verdict: Verdict = { severity: 'additive', confidence: 1, notes: [] };
  return {
    verdict,
    breaking(note) {
      breakingNotes.push(note);
      verdict.severity = 'breaking';
      verdict.notes = [...breakingNotes, ...additiveNotes];
    },
    additive(note, confidence) {
      additiveNotes.push(note);
      if (confidence !== undefined) verdict.confidence = Math.min(verdict.confidence, confidence);
      verdict.notes = [...breakingNotes, ...additiveNotes];
    },
  };
}

function thisNote(sig: SignatureComparison): string | undefined {
  const t = sig.thisParameter;
  if (!t) return undefined;
  if (t.relation === 'added') return `this parameter added (${t.after})`;
  if (t.relation === 'removed') return 'this parameter removed';
  if (t.relation === 'equivalent') return undefined;
  return `this parameter type changed (${t.before} -> ${t.after})`;
}

/** The consumer calls this: arguments flow in, the return flows out. */
function callerVerdict(sigs: SignatureComparison[]): Verdict {
  const c = collect();
  for (const sig of sigs) {
    const t = thisNote(sig);
    if (t) c.additive(t);
    for (const p of sig.parameters) {
      if (p.relation === 'removed') {
        c.breaking(`parameter '${p.name}' removed`);
        continue;
      }
      if (p.relation === 'added') {
        if (p.optionalAfter) c.additive(`optional parameter '${p.name}' added`);
        else c.breaking(`required parameter '${p.name}' added`);
        continue;
      }
      if (p.optionalBefore && !p.optionalAfter) c.breaking(`parameter '${p.name}' became required`);
      else if (!p.optionalBefore && p.optionalAfter)
        c.additive(`parameter '${p.name}' became optional`);
      if (p.relation === 'narrowed') c.breaking(`parameter '${p.name}' type narrowed`);
      else if (p.relation === 'incompatible') c.breaking(`parameter '${p.name}' type changed`);
      else if (p.relation === 'widened') c.additive(`parameter '${p.name}' type widened`, 0.8);
    }
    if (sig.returnType === 'widened')
      c.breaking('return type widened; callers must handle new cases');
    else if (sig.returnType === 'incompatible') c.breaking('return type changed');
    else if (sig.returnType === 'narrowed') c.additive('return type narrowed (safe for callers)');
  }
  return finish(c.verdict);
}

/** The consumer implements this function: parameters flow in from the package, the return flows out to it. */
function implementerVerdict(sigs: SignatureComparison[]): Verdict {
  const c = collect();
  for (const sig of sigs) {
    const t = thisNote(sig);
    if (t) c.additive(t);
    for (const p of sig.parameters) {
      if (p.relation === 'removed') {
        c.breaking(`callback parameter '${p.name}' removed`);
        continue;
      }
      if (p.relation === 'added') {
        c.additive(`callback parameter '${p.name}' added (implementations may ignore it)`);
        continue;
      }
      // The implementer receives the argument; it being always present now costs nothing.
      if (p.optionalBefore && !p.optionalAfter)
        c.additive(`callback parameter '${p.name}' now always provided`);
      if (p.relation === 'widened')
        c.breaking(`callback parameter '${p.name}' widened; implementations must accept more`);
      else if (p.relation === 'incompatible')
        c.breaking(`callback parameter '${p.name}' type changed`);
      else if (p.relation === 'narrowed')
        c.additive(`callback parameter '${p.name}' narrowed`, 0.6);
    }
    if (sig.returnType === 'narrowed')
      c.breaking('callback return type narrowed; implementations must return less');
    else if (sig.returnType === 'incompatible') c.breaking('callback return type changed');
    else if (sig.returnType === 'widened') c.additive('callback return type widened');
  }
  return finish(c.verdict);
}

/** Parameter widening on its own is the only reason that lowers confidence without a note in the output. */
function finish(verdict: Verdict): Verdict {
  const notes = verdict.notes.filter(
    (n) => !/type widened$/.test(n) || verdict.severity === 'breaking',
  );
  return { ...verdict, notes };
}

/** Type parameter names of every `<...>` list in declaration position, in order. */
function typeParamNames(list: string): string[] {
  return splitTopLevel(list, ',')
    .map((p) => /^(const\s+)?([A-Za-z_$][\w$]*)/.exec(p.trim())?.[2])
    .filter((n): n is string => n !== undefined);
}

/**
 * Renames type parameters positionally (T0, T1, ...) so `<T>(v: T): T` and `<U>(v: U): U`
 * read the same. Works per overload for callables and on the header for aliases.
 */
export function normalizeTypeParams(text: string): { normalized: string; generic: boolean } {
  let generic = false;
  const rename = (segment: string, names: string[]): string => {
    if (names.length === 0) return segment;
    generic = true;
    let out = segment;
    names.forEach((name, i) => {
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'), `T${i}`);
    });
    return out;
  };
  const alias = /^type<((?:[^<>]|<[^<>]*>)*)> = /.exec(text);
  if (alias) return { normalized: rename(text, typeParamNames(alias[1] as string)), generic };
  const overloads = parseCallable(asCallable(text) ?? text);
  if (!overloads) return { normalized: text, generic: false };
  const segments = splitTopLevel(asCallable(text) ?? text, ';');
  const normalized = segments
    .map((seg, i) =>
      rename(
        seg,
        (overloads[i]?.typeParams ?? []).map((tp) => typeParamNames(tp)[0] ?? ''),
      ),
    )
    .join('; ');
  return { normalized, generic };
}

const GENERIC_DIFFER: Verdict = {
  severity: 'breaking',
  confidence: 0.7,
  notes: ['generic signatures differ'],
};

export const TYPE_ARGS_NOTE = 'explicit type arguments will no longer compile';
const TYPE_PARAMS_LOST: Verdict = {
  severity: 'breaking',
  confidence: 0.6,
  notes: [TYPE_ARGS_NOTE],
};

/** A caller who passed explicit type arguments breaks when an overload has fewer type parameters than before. */
function lostTypeParameters(comparison: TypeComparison): boolean {
  const counts = comparison.typeParameterCounts;
  if (!counts) return false;
  const max = Math.max(counts.before.length, counts.after.length);
  for (let i = 0; i < max; i++) {
    if ((counts.before[i] ?? 0) > (counts.after[i] ?? 0)) return true;
  }
  return false;
}

function kindFor(relation: TypeRelation): 'widened' | 'narrowed' | 'type' {
  return relation === 'widened' ? 'widened' : relation === 'narrowed' ? 'narrowed' : 'type';
}

/** `any` on one side makes whole function types look equivalent; the per-parameter detail is what counts. */
function isEquivalent(comparison: TypeComparison): boolean {
  if (comparison.relation !== 'equivalent') return false;
  return (comparison.signatures ?? []).every(
    (s) => s.returnType === 'equivalent' && s.parameters.every((p) => p.relation === 'equivalent'),
  );
}

/** For a callback the whole-type relation may be equivalent while a parameter moved; take the kind from the parameters then. */
function callbackKind(comparison: TypeComparison): 'widened' | 'narrowed' | 'type' {
  if (comparison.relation !== 'equivalent') return kindFor(comparison.relation);
  const relations = (comparison.signatures ?? []).flatMap((s) => [
    s.returnType,
    ...s.parameters.map((p) => p.relation),
  ]);
  if (relations.includes('narrowed')) return 'narrowed';
  if (relations.includes('widened')) return 'widened';
  return 'type';
}

function apply(change: UnclassifiedChange, verdict: Verdict): void {
  change.evidence = 'checker';
  change.severity = verdict.severity;
  change.confidence = Math.min(change.confidence, verdict.confidence);
  if (verdict.notes.length > 0) change.notes = verdict.notes.join('; ');
  else delete change.notes;
}

export function refineWithTypes(
  changes: UnclassifiedChange[],
  comparisons: Map<string, TypeComparison>,
  surfaceB: ApiSurface,
): UnclassifiedChange[] {
  const symbols = new Map(surfaceB.symbols.map((s) => [s.path, s]));
  // A collapsed `{…}` literal the checker could relate speaks for its members too.
  const literalParents = [...comparisons.keys()].filter((p) => {
    const b = symbols.get(p);
    return (
      b?.signature.includes('{…}') || changes.some((c) => c.path === p && c.before?.includes('{…}'))
    );
  });
  const underLiteral = (path: string): boolean =>
    literalParents.some(
      (p) => path.length > p.length && path.startsWith(p) && /[#[]/.test(path[p.length] as string),
    );
  const out: UnclassifiedChange[] = [];
  for (const change of changes) {
    if ((change.kind === 'removed' || change.kind === 'added') && underLiteral(change.path))
      continue;
    if (change.kind !== 'signature' && change.kind !== 'type') {
      out.push(change);
      continue;
    }
    if (
      change.notes === 'member became optional' ||
      change.notes === 'no longer callable' ||
      change.notes === 'became callable'
    ) {
      out.push(change);
      continue;
    }
    const comparison = comparisons.get(change.path);
    const symbol = symbols.get(change.path);
    const kindChanged = change.notes?.startsWith('declaration kind changed') === true;
    if (!comparison || !symbol) {
      out.push(change);
      continue;
    }
    if (comparison.callable && lostTypeParameters(comparison)) {
      const refined: UnclassifiedChange = { ...change, kind: 'signature' };
      apply(refined, TYPE_PARAMS_LOST);
      if (kindChanged) refined.notes = `${change.notes}; ${refined.notes}`;
      out.push(refined);
      continue;
    }
    if (
      isEquivalent(comparison) &&
      (!kindChanged || /(interface|type) to (interface|type)/.test(change.notes ?? ''))
    ) {
      // Same contract, different spelling. Nothing for a consumer to do.
      continue;
    }
    if (kindChanged) {
      // `const record: typeof ZodRecord.create` becoming a function: both are called, so compare the calls.
      const valueToValue =
        /(variable|function|method|property) to (variable|function|method|property)/.test(
          change.notes ?? '',
        );
      if (valueToValue && comparison.callable) {
        if (isEquivalent(comparison)) continue;
        const refined: UnclassifiedChange = { ...change, kind: 'signature' };
        const verdict = comparison.signatures
          ? callerVerdict(comparison.signatures)
          : comparison.relation === 'narrowed'
            ? {
                severity: 'additive' as const,
                confidence: 1,
                notes: ['signature narrowed (compatible for callers)'],
              }
            : {
                severity: 'breaking' as const,
                confidence: 1,
                notes: [
                  comparison.relation === 'widened'
                    ? 'signature widened; callers must handle new cases'
                    : 'signature incompatible',
                ],
              };
        apply(refined, verdict);
        refined.notes = [change.notes, refined.notes].filter(Boolean).join('; ');
        out.push(refined);
        continue;
      }
      out.push(change);
      continue;
    }
    const role = roleOf(symbol, comparison, symbols);
    if (!role) {
      out.push(change);
      continue;
    }
    const refined: UnclassifiedChange = { ...change };
    // Two generic signatures the checker cannot relate either way: the same modulo type
    // parameter names is no change; anything else is a low-confidence incompatibility.
    if (
      comparison.relation === 'incompatible' &&
      !comparison.signatures &&
      change.before &&
      change.after
    ) {
      const a = normalizeTypeParams(change.before);
      const b = normalizeTypeParams(change.after);
      if (a.generic && b.generic) {
        if (a.normalized === b.normalized) continue;
        refined.kind = 'type';
        apply(refined, GENERIC_DIFFER);
        out.push(refined);
        continue;
      }
    }
    switch (role) {
      case 'callable': {
        refined.kind = 'signature';
        if (comparison.signatures) apply(refined, callerVerdict(comparison.signatures));
        else if (comparison.relation === 'narrowed')
          apply(refined, {
            severity: 'additive',
            confidence: 1,
            notes: ['signature narrowed (compatible for callers)'],
          });
        else
          apply(refined, {
            severity: 'breaking',
            confidence: 1,
            notes: [
              comparison.relation === 'widened'
                ? 'signature widened; callers must handle new cases'
                : 'signature incompatible',
            ],
          });
        break;
      }
      case 'callback': {
        refined.kind = callbackKind(comparison);
        if (comparison.signatures) apply(refined, implementerVerdict(comparison.signatures));
        else if (comparison.relation === 'widened')
          apply(refined, {
            severity: 'additive',
            confidence: 1,
            notes: ['callback type widened (implementations still fit)'],
          });
        else
          apply(refined, {
            severity: 'breaking',
            confidence: 1,
            notes: ['callback type incompatible with existing implementations'],
          });
        break;
      }
      case 'output': {
        refined.kind = kindFor(comparison.relation);
        if (comparison.relation === 'narrowed')
          apply(refined, {
            severity: 'additive',
            confidence: 1,
            notes: ['type narrowed (safe for readers)'],
          });
        else if (comparison.relation === 'widened')
          apply(refined, {
            severity: 'breaking',
            confidence: 1,
            notes: ['type widened; readers must handle new cases'],
          });
        else apply(refined, { severity: 'breaking', confidence: 1, notes: ['type incompatible'] });
        break;
      }
      case 'unknown': {
        refined.kind = kindFor(comparison.relation);
        if (comparison.relation === 'widened')
          apply(refined, { severity: 'additive', confidence: 0.6, notes: [WIDENED_NOTE] });
        else if (comparison.relation === 'narrowed')
          apply(refined, { severity: 'breaking', confidence: 0.7, notes: ['type narrowed'] });
        else apply(refined, { severity: 'breaking', confidence: 1, notes: ['type incompatible'] });
        break;
      }
    }
    out.push(refined);
  }
  return out;
}
