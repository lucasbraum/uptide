import type { Change, Severity } from '../domain/change.js';
import { leafOf, parentOf } from '../domain/path.js';
import { TYPE_ARGS_NOTE, WIDENED_NOTE } from './refine.js';
import {
  asCallable,
  type Overload,
  parseCallable,
  splitTopLevel,
  unionMembers,
} from './signature-parse.js';

export type UnclassifiedChange = Omit<Change, 'severity'> & { severity?: Severity };

interface Verdict {
  severity: Severity;
  confidence?: number;
  notes?: string;
  /** The textual comparison can also tell the direction; the kind says so, like the checker path does. */
  kind?: 'widened' | 'narrowed';
}

const BREAKING: Verdict = { severity: 'breaking' };
const ADDITIVE: Verdict = { severity: 'additive' };

type Relation = 'same' | 'wider' | 'narrower' | 'different';

/** How `after` relates to `before` as a set of union members. `any`/`unknown` after anything is wider. */
function relate(before: string, after: string): Relation {
  if (before === after) return 'same';
  if (after === 'any' || after === 'unknown') return 'wider';
  const a = new Set(unionMembers(before));
  const b = new Set(unionMembers(after));
  const aInB = [...a].every((m) => b.has(m));
  const bInA = [...b].every((m) => a.has(m));
  if (aInB && !bInA) return 'wider';
  if (bInA && !aInB) return 'narrower';
  return 'different';
}

/**
 * Parameters are contravariant: a wider parameter accepts every old call. Return types
 * are covariant: a narrower return still satisfies every old reader. Everything else is
 * breaking. Overloads: every old overload must survive verbatim for the change to be
 * additive; one changed overload is compared structurally; anything else is breaking.
 */
/** A method returning `this` returns its container; spell it that way so `X -> this` is not a change. */
function normalizeThis(type: string, path: string): string {
  const container = parentOf(path);
  return type === 'this' && container !== undefined ? leafOf(container) : type;
}

function classifyCallable(before: Overload[], after: Overload[], path = ''): Verdict {
  const key = (o: Overload): string => JSON.stringify(o);
  const beforeKeys = before.map(key);
  const afterKeys = new Set(after.map(key));
  if (beforeKeys.every((k) => afterKeys.has(k))) {
    return { severity: 'additive', notes: 'overload added' };
  }
  if (before.length !== 1 || after.length !== 1)
    return { severity: 'breaking', notes: 'overload removed or changed' };
  const [a, b] = [before[0] as Overload, after[0] as Overload];

  if (a.typeParams.length > b.typeParams.length) {
    return { severity: 'breaking', confidence: 0.6, notes: TYPE_ARGS_NOTE };
  }
  if (a.typeParams.join(',') !== b.typeParams.join(',')) {
    const added = b.typeParams.slice(a.typeParams.length);
    const prefixSame = a.typeParams.every((p, i) => b.typeParams[i] === p);
    if (prefixSame && added.every((p) => p.includes('='))) {
      return { severity: 'additive', notes: 'type parameter with default added' };
    }
    if (a.typeParams.length === b.typeParams.length) {
      // Same arity: callers without explicit type arguments usually still compile.
      return {
        severity: 'breaking',
        confidence: 0.5,
        notes: 'type parameter constraints changed; explicit type arguments may not compile',
      };
    }
    return { severity: 'breaking', notes: 'type parameters changed' };
  }

  const returnRelation = relate(
    normalizeThis(a.returnType, path),
    normalizeThis(b.returnType, path),
  );
  if (returnRelation === 'different')
    return { severity: 'breaking', confidence: 0.7, notes: 'return type changed' };
  if (returnRelation === 'wider')
    return { severity: 'breaking', notes: 'return type widened; callers must handle new cases' };
  const returnNote =
    returnRelation === 'narrower' ? 'return type narrowed (safe for readers)' : undefined;

  const notes: string[] = returnNote ? [returnNote] : [];
  if (a.thisType === undefined && b.thisType !== undefined)
    notes.push(`this parameter added (${b.thisType})`);
  else if (a.thisType !== undefined && b.thisType === undefined)
    notes.push('this parameter removed');
  let confidence: number | undefined;
  const max = Math.max(a.params.length, b.params.length);
  for (let i = 0; i < max; i++) {
    const pa = a.params[i];
    const pb = b.params[i];
    if (pa && !pb) return { severity: 'breaking', notes: `parameter '${pa.name}' removed` };
    if (!pa && pb) {
      if (pb.optional || pb.rest) {
        notes.push(`optional parameter '${pb.name}' added`);
        continue;
      }
      return { severity: 'breaking', notes: `required parameter '${pb.name}' added` };
    }
    if (!pa || !pb) continue;
    if (pa.rest !== pb.rest)
      return { severity: 'breaking', notes: `parameter '${pa.name}' rest-ness changed` };
    if (!pa.optional && pb.optional) notes.push(`parameter '${pa.name}' became optional`);
    if (pa.optional && !pb.optional)
      return { severity: 'breaking', notes: `parameter '${pa.name}' became required` };
    const rel = relate(pa.type, pb.type);
    if (rel === 'wider') confidence = 0.8;
    else if (rel === 'narrower')
      return { severity: 'breaking', notes: `parameter '${pa.name}' type narrowed` };
    else if (rel === 'different') {
      if (pa.type.startsWith('{') && /^[A-Za-z_$][\w$.]*(<.*>)?$/.test(pb.type)) {
        return {
          severity: 'breaking',
          confidence: 0.5,
          notes: `parameter '${pa.name}' inline type replaced by named type ${pb.type}; may be equivalent`,
        };
      }
      return {
        severity: 'breaking',
        confidence: 0.7,
        notes: `parameter '${pa.name}' type changed`,
      };
    }
  }
  const verdict: Verdict = { severity: 'additive', notes: notes.join('; ') || undefined };
  if (confidence !== undefined) verdict.confidence = confidence;
  return verdict;
}

/** Shared by property and alias widening, where the consumer's direction is unknown. */
const WIDENED = { confidence: 0.6, notes: WIDENED_NOTE } as const;

/**
 * Properties and type aliases are read and written by consumers, so neither direction is
 * safe for everyone. The project rule is that loosening is additive; that is reported with
 * reduced confidence and a note, so a reviewer sees the judgement call.
 */
function classifyType(before: string, after: string): Verdict {
  const rel = relate(before, after);
  if (rel === 'wider') return { severity: 'additive', kind: 'widened', ...WIDENED };
  if (rel === 'narrower')
    return { severity: 'breaking', kind: 'narrowed', confidence: 0.7, notes: 'type narrowed' };
  // Text alone cannot prove two types incompatible; the checker path reports 1.
  return { severity: 'breaking', confidence: 0.7, notes: 'type changed' };
}

/**
 * A declaration changing kind is not automatically breaking. What consumers can do with
 * the name is what matters: construct it, `instanceof` it, extend it, merge into it.
 */
const VALUE_KINDS = new Set(['variable', 'function', 'method', 'property']);

/** `variable: const { (a): B }` -> `(a): B`; `function: (a): B` -> `(a): B`. */
function callableText(kindAndSignature: string): string | undefined {
  return asCallable(kindAndSignature.slice(kindAndSignature.indexOf(':') + 2));
}

function classifyKindChange(before: string, after: string, note: string, path: string): Verdict {
  const [fromKind, toKind] = [before.split(':')[0] as string, after.split(':')[0] as string];
  const pair = `${fromKind}->${toKind}`;
  if (VALUE_KINDS.has(fromKind) && VALUE_KINDS.has(toKind)) {
    // Both are things a consumer calls; what matters is whether the calls still work.
    const a = callableText(before);
    const b = callableText(after);
    const pa = a ? parseCallable(a) : undefined;
    const pb = b ? parseCallable(b) : undefined;
    if (pa && pb) {
      const verdict = classifyCallable(pa, pb, path);
      return { ...verdict, notes: [note, verdict.notes].filter(Boolean).join('; ') };
    }
  }
  if (pair === 'interface->type' || pair === 'type->interface') {
    return {
      severity: 'additive',
      confidence: 0.7,
      notes: `${note}; usable the same way, but declaration merging and extends may differ`,
    };
  }
  if (
    pair === 'method->property' ||
    pair === 'property->method' ||
    pair === 'function->variable' ||
    pair === 'variable->function' ||
    pair === 'variable->namespace' ||
    pair === 'namespace->variable'
  ) {
    return {
      severity: 'additive',
      confidence: 0.7,
      notes: `${note}; call sites keep working if the property is callable`,
    };
  }
  if (fromKind === 'class' && toKind === 'variable') {
    return {
      severity: 'breaking',
      confidence: 0.6,
      notes: `${note}; a value+type pair may still construct, but extends/instanceof may break`,
    };
  }
  return { severity: 'breaking', notes: note };
}

/** Container headers: a grown extends/implements list is additive, anything else breaking. */
function classifyHeader(before: string, after: string): Verdict {
  const parse = (h: string) => {
    const m = /^(abstract )?(class|interface)(<.*>)?(?: extends (.+?))?(?: implements (.+))?$/.exec(
      h,
    );
    if (!m) return undefined;
    return {
      abstract: m[1] !== undefined,
      kind: m[2],
      typeParams: m[3] ?? '',
      extends: m[4] ? splitTopLevel(m[4], ',') : [],
      implements: m[5] ? splitTopLevel(m[5], ',') : [],
    };
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b || a.kind !== b.kind || a.typeParams !== b.typeParams) return BREAKING;
  if (a.abstract && !b.abstract) return { severity: 'additive', notes: 'no longer abstract' };
  if (!a.abstract && b.abstract) return { severity: 'breaking', notes: 'became abstract' };
  const grew = (x: string[], y: string[]) => x.every((m) => y.includes(m)) && y.length > x.length;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((m) => y.includes(m));
  if (
    (grew(a.extends, b.extends) || same(a.extends, b.extends)) &&
    (grew(a.implements, b.implements) || same(a.implements, b.implements))
  ) {
    return {
      severity: 'additive',
      confidence: 0.8,
      notes: 'base list grew; inherited members are new API',
    };
  }
  return { severity: 'breaking', notes: 'base list changed' };
}

function verdictFor(change: UnclassifiedChange): Verdict {
  switch (change.kind) {
    case 'added':
      return ADDITIVE;
    case 'deprecated':
      return { severity: 'deprecated' };
    case 'removed':
    case 'renamed':
    case 'moved':
    case 'required':
      return BREAKING;
    case 'widened':
      return { severity: 'additive', confidence: 0.6, notes: WIDENED_NOTE };
    case 'narrowed':
      return { severity: 'breaking', confidence: 0.7, notes: 'type narrowed' };
    case 'cause':
    case 'module-format':
      // Never produced by the surface diff; Finding-only and manifest-only kinds.
      return BREAKING;
    case 'signature':
    case 'type': {
      const { before, after } = change;
      if (before === undefined || after === undefined) return BREAKING;
      if (change.notes === 'member became optional') return ADDITIVE;
      if (change.notes === 'no longer callable' || change.notes === 'became callable')
        return BREAKING;
      if (change.notes?.startsWith('declaration kind changed')) {
        return classifyKindChange(before, after, change.notes, change.path);
      }
      const callableLike = /^(protected |abstract |static )*(<|\()/;
      if (callableLike.test(before) && callableLike.test(after)) {
        const a = parseCallable(before);
        const b = parseCallable(after);
        if (a && b) return classifyCallable(a, b, change.path);
        return { severity: 'breaking', notes: 'signature changed (not parsed)' };
      }
      if (
        /^(abstract )?(class|interface)/.test(before) &&
        /^(abstract )?(class|interface)/.test(after)
      ) {
        return classifyHeader(before, after);
      }
      if (change.kind === 'type') return classifyType(before, after);
      return BREAKING;
    }
  }
}

/** Pure: assigns severity from kind and, for signature/type changes, from the direction of the change. */
export function classify(changes: UnclassifiedChange[]): Change[] {
  return changes.map((change) => {
    // A severity set upstream (assignability refinement, `moved`) is final.
    if (change.severity !== undefined) return { ...change, severity: change.severity };
    const verdict = verdictFor(change);
    const out: Change = { ...change, severity: verdict.severity };
    if (verdict.kind) out.kind = verdict.kind;
    const judged =
      out.kind === 'signature' ||
      out.kind === 'type' ||
      out.kind === 'widened' ||
      out.kind === 'narrowed';
    if (judged && out.evidence === undefined) out.evidence = 'text';
    if (verdict.confidence !== undefined)
      out.confidence = Math.min(out.confidence, verdict.confidence);
    if (verdict.notes) {
      out.notes =
        out.notes && !verdict.notes.startsWith(out.notes)
          ? `${out.notes}; ${verdict.notes}`
          : verdict.notes;
    }
    return out;
  });
}
