import type { Change } from '../domain/change.js';
import { joinPath, leafOf, parentOf, splitPath } from '../domain/path.js';
import type { ApiSurface, ApiSymbol } from '../domain/surface.js';
import { classify, type UnclassifiedChange } from './classify.js';
import { asCallable, callableShape } from './signature-parse.js';
import { similarity } from './similarity.js';

const CONTAINER_KINDS = new Set(['class', 'interface', 'namespace', 'enum', 'module', 'type']);

function withVisibility<T extends UnclassifiedChange>(change: T, symbol: ApiSymbol): T {
  if (symbol.visibility) change.visibility = symbol.visibility;
  if (symbol.aliasOf) change.aliasOf = symbol.aliasOf;
  return change;
}

/**
 * What a consumer can do with the symbol. A variable holding a function is called like a
 * function; a property holding a function is called like a method. The declaration
 * keyword only matters when the symbol stops (or starts) being callable.
 */
function effectiveKind(symbol: ApiSymbol): ApiSymbol['kind'] {
  if (symbol.kind === 'variable' && asCallable(symbol.signature) !== undefined) return 'function';
  if (symbol.kind === 'property' && asCallable(symbol.signature) !== undefined) return 'method';
  return symbol.kind;
}

/** Structural kinds that behave the same for consumers: a header change is a `signature` change, a value/type change is a `type` change. */
function changeKindFor(symbol: ApiSymbol): 'signature' | 'type' {
  return symbol.kind === 'function' ||
    symbol.kind === 'method' ||
    symbol.kind === 'class' ||
    symbol.kind === 'interface' ||
    symbol.kind === 'namespace' ||
    symbol.kind === 'module'
    ? 'signature'
    : 'type';
}

export function sortByPath<T extends { path: string }>(changes: T[]): T[] {
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * Compares two surfaces by canonical path and returns classified changes, sorted by path.
 * Pure. See docs/architecture.md "Diff semantics" for the rules.
 */
export function diffSurfaces(a: ApiSurface, b: ApiSurface): Change[] {
  return sortByPath(classify(rawDiff(a, b)));
}

/**
 * `export = sharp` (a function or class merged with a namespace) and `export default sharp`
 * plus named exports are the same thing to a consumer: the default import is the value and
 * the namespace members are the named exports. When one side is written the first way and
 * the other the second (sharp 0.34 -> 0.35), paths under the `export =` root are looked up
 * under their ESM spelling on the other side: `sharp` -> `default`, `sharp#()` -> `default#()`,
 * `sharp.ResizeOptions#width` -> `ResizeOptions#width`.
 */
interface Equivalence {
  active: boolean;
  lookup(path: string): ApiSymbol | undefined;
  /** The `export =` side's symbol for a path spelled the other way (`Instance` -> `shape.Instance`). */
  reverse(path: string, own: Map<string, ApiSymbol>): ApiSymbol | undefined;
  /** Rewrites `name.X` qualifiers in a signature written on the `export =` side. */
  normalize(signature: string): string;
}

/** Drops a `name.` qualifier before identifiers: `pino.Logger` reads as `Logger`. */
function unqualify(name: string): (signature: string) => string {
  const qualifier = new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\.(?=[A-Za-z_$])`, 'g');
  return (signature) => signature.replace(qualifier, '');
}

function esmEquivalence(from: ApiSurface, other: Map<string, ApiSymbol>): Equivalence {
  const identity: Equivalence = {
    active: false,
    lookup: (path) => other.get(path),
    reverse: () => undefined,
    normalize: (s) => s,
  };
  const root = from.symbols.find((s) => s.exportEquals);
  if (!root) return identity;
  // The other side spells the root `default`, or keeps the declared name without the namespace.
  const otherRoot = other.get(root.path) ?? other.get('default');
  if (!otherRoot || otherRoot.exportEquals) return identity;
  const name = root.path;
  const rootPath = otherRoot.path;
  return {
    active: true,
    lookup(path) {
      const direct = other.get(path);
      if (direct) return direct;
      if (path === name) return otherRoot;
      if (path.startsWith(`${name}#`)) return other.get(`${rootPath}${path.slice(name.length)}`);
      if (path.startsWith(`${name}.`)) {
        const rest = path.slice(name.length + 1);
        return rest === 'new()' ? other.get(`${rootPath}.new()`) : other.get(rest);
      }
      return undefined;
    },
    reverse(path, own) {
      if (path === rootPath) return own.get(name);
      if (path.startsWith(`${rootPath}#`)) return own.get(`${name}${path.slice(rootPath.length)}`);
      if (path === `${rootPath}.new()`) return own.get(`${name}.new()`);
      return own.get(`${name}.${path}`);
    },
    normalize: unqualify(name),
  };
}

/** The textual comparison before severity is assigned; `diffPackage` refines it with the type checker first. */
/** What the extraction records instead of walking a declaration again: `recursive type pino (compared by name)`. */
const CUT = /^recursive type (.+) \(compared by name\)$/;
const isCut = (s: ApiSymbol | undefined): s is ApiSymbol => !!s && CUT.test(s.signature);

/**
 * A path looked up on one side through that side's cycle cuts: when `pino.pino` was cut as
 * a cycle back to `pino`, `pino.pino.stdTimeFunctions` is `pino.stdTimeFunctions`. Undefined
 * when no cut covers the path or the rewritten path is not there either.
 */
export function throughCuts(
  symbols: Map<string, ApiSymbol>,
): (path: string) => ApiSymbol | undefined {
  const cuts = new Map<string, string>();
  for (const s of symbols.values()) {
    const target = CUT.exec(s.signature)?.[1];
    if (target !== undefined) cuts.set(s.path, target);
  }
  return (path) => {
    let current = path;
    // Cuts can lead to cuts; each hop shortens nothing, so the hops are bounded.
    for (let hop = 0; cuts.size > 0 && hop < 16; hop++) {
      const parts = splitPath(current);
      let rewritten: string | undefined;
      for (let n = parts.segments.length; n >= 1 && rewritten === undefined; n--) {
        const target = cuts.get(joinPath({ ...parts, segments: parts.segments.slice(0, n) }));
        if (target === undefined) continue;
        const into = splitPath(target);
        rewritten = joinPath({ ...into, segments: [...into.segments, ...parts.segments.slice(n)] });
      }
      if (rewritten === undefined) return undefined;
      const found = symbols.get(rewritten);
      if (found && !isCut(found)) return found;
      current = rewritten;
    }
    return undefined;
  };
}

export function rawDiff(a: ApiSurface, b: ApiSurface): UnclassifiedChange[] {
  const meta = { package: b.package, from: a.version, to: b.version };
  const inA = new Map(a.symbols.map((s) => [s.path, s]));
  const inB = new Map(b.symbols.map((s) => [s.path, s]));
  const raw: UnclassifiedChange[] = [];
  const removed: ApiSymbol[] = [];
  const added: ApiSymbol[] = [];
  const equivB = esmEquivalence(a, inB);
  const equivA = esmEquivalence(b, inA);
  const viaB = throughCuts(inB);
  const viaA = throughCuts(inA);

  for (const cut of a.symbols) {
    let found = equivB.lookup(cut.path);
    // A cycle cut on one side only is compared with what it stands for on that side, under
    // this path; cut on both sides, the two compare by name like any signature.
    const resolvedB = !found || (isCut(found) && !isCut(cut)) ? viaB(cut.path) : undefined;
    if (resolvedB) found = { ...resolvedB, path: cut.path };
    const resolvedA = isCut(cut) && found && !isCut(found) ? viaA(cut.path) : undefined;
    let original = resolvedA ? { ...resolvedA, path: cut.path } : cut;
    // Through a cut back to namespace `pino`, one side names its members `pino.Logger` and
    // the other, declared inside the namespace, `Logger`: the same types, read unqualified.
    const through = resolvedB ?? resolvedA;
    if (through && found) {
      const plain = unqualify(leafOf(through.path));
      original = { ...original, signature: plain(original.signature) };
      found = { ...found, signature: plain(found.signature) };
    }
    // Under the ESM equivalence both sides are read without the namespace qualifier.
    const before = equivB.active
      ? { ...original, signature: equivB.normalize(original.signature) }
      : original;
    const after =
      found && equivA.active ? { ...found, signature: equivA.normalize(found.signature) } : found;
    if (!after) {
      removed.push(before);
      continue;
    }
    if (!after.exportedFrom.some((e) => before.exportedFrom.includes(e))) {
      const [target] = [...after.exportedFrom].sort();
      raw.push(
        withVisibility(
          {
            ...meta,
            path: before.path,
            kind: 'moved',
            severity: 'breaking',
            source: 'types',
            confidence: 0.95,
            replacement: target as string,
            notes: `no longer exported from ${before.exportedFrom.join(', ')}; now exported from ${after.exportedFrom.join(', ')}`,
          },
          before,
        ),
      );
    }
    compareSymbol(meta, before, after, raw);
  }
  for (const after of b.symbols) {
    if (!equivA.lookup(after.path) && !equivB.reverse(after.path, inA) && !viaA(after.path))
      added.push(after);
  }

  const hints = renameHints(removed, added, a.symbols, b.symbols);
  for (const symbol of removed) {
    const hint = hints.get(symbol.path);
    const change: UnclassifiedChange = {
      ...meta,
      path: symbol.path,
      kind: 'removed',
      before: symbol.signature,
      source: 'types',
      confidence: hint ? hint.confidence : 1,
    };
    if (hint) {
      change.replacement = hint.replacement;
      change.notes = hint.notes;
    }
    if (symbol.deprecated !== undefined) {
      change.notes = [change.notes, 'was deprecated'].filter(Boolean).join('; ');
    }
    raw.push(withVisibility(change, symbol));
  }
  for (const symbol of added) {
    raw.push(
      withVisibility(
        {
          ...meta,
          path: symbol.path,
          kind: 'added',
          after: symbol.signature,
          source: 'types',
          confidence: 1,
        },
        symbol,
      ),
    );
  }

  return raw;
}

function compareSymbol(
  meta: { package: string; from: string; to: string },
  before: ApiSymbol,
  after: ApiSymbol,
  out: UnclassifiedChange[],
): void {
  const base = { ...meta, path: before.path, source: 'types' as const, confidence: 1 };
  const push = (change: UnclassifiedChange): number => out.push(withVisibility(change, after));

  const kindA = effectiveKind(before);
  const kindB = effectiveKind(after);
  if (kindA !== kindB && before.kind === after.kind) {
    // Same declaration, different callable-ness. A function or variable the consumer calls
    // stopping being callable is the news; a property's type changing is a type change and
    // assignability decides (a callback replaced by a union that still contains it is widened).
    const change: UnclassifiedChange = {
      ...base,
      kind: changeKindFor(before),
      before: before.signature,
      after: after.signature,
    };
    if (before.kind !== 'property') {
      change.notes =
        kindA === 'method' || kindA === 'function' ? 'no longer callable' : 'became callable';
    }
    push(change);
  } else if (kindA !== kindB) {
    push({
      ...base,
      kind: 'signature',
      before: `${before.kind}: ${before.signature}`,
      after: `${after.kind}: ${after.signature}`,
      notes: `declaration kind changed from ${before.kind} to ${after.kind}`,
    });
  } else if (kindA === 'function' || kindA === 'method') {
    // The same callable to a consumer whether it was a const arrow or a function declaration.
    const textA = asCallable(before.signature) ?? before.signature;
    const textB = asCallable(after.signature) ?? after.signature;
    if (textA !== textB && callableShape(before.signature) !== callableShape(after.signature)) {
      push({ ...base, kind: 'signature', before: textA, after: textB });
    }
  } else if (before.signature !== after.signature) {
    push({
      ...base,
      kind: changeKindFor(before),
      before: before.signature,
      after: after.signature,
    });
  }

  const wasOptional = before.optional === true;
  const isOptional = after.optional === true;
  if (wasOptional && !isOptional) {
    push({
      ...base,
      kind: 'required',
      before: `${before.signature} (optional)`,
      after: after.signature,
    });
  } else if (!wasOptional && isOptional) {
    push({
      ...base,
      kind: 'type',
      before: before.signature,
      after: `${after.signature} (optional)`,
      notes: 'member became optional',
    });
  }

  if (before.deprecated === undefined && after.deprecated !== undefined) {
    const change: UnclassifiedChange = { ...base, kind: 'deprecated', source: 'jsdoc' };
    if (typeof after.deprecated === 'string') change.notes = after.deprecated;
    push(change);
  }
}

interface Hint {
  replacement: string;
  confidence: number;
  notes: string;
}

/** Leaf name + signature of every member directly or indirectly under a container. */
function memberFingerprints(container: string, symbols: ApiSymbol[]): Set<string> {
  const out = new Set<string>();
  for (const s of symbols) {
    if (
      s.path.length > container.length &&
      s.path.startsWith(container) &&
      /[.#[]/.test(s.path[container.length] as string)
    ) {
      out.add(`${s.path.slice(container.length)}=${s.signature}`);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * A removed symbol and an added symbol under the same parent with the same kind are a
 * probable rename when the evidence is specific enough. Leaves (functions, properties)
 * carry that evidence in their signature. Containers do not (hundreds of Stripe interfaces
 * share the header `interface extends EventBase`), so they are matched on name similarity
 * plus overlap of their members. We say so on the `removed` change and leave the `added`
 * one alone: a wrong "renamed" would send a code modifier down the wrong path, a hint only
 * costs a reviewer a glance. Members of a hinted container inherit the hint when their
 * counterpart exists under the new name. Ties produce no hint.
 */
function renameHints(
  removed: ApiSymbol[],
  added: ApiSymbol[],
  allA: ApiSymbol[],
  allB: ApiSymbol[],
): Map<string, Hint> {
  const hints = new Map<string, Hint>();
  const addedByPath = new Map(added.map((s) => [s.path, s]));
  const addedByParent = new Map<string, ApiSymbol[]>();
  for (const s of added) {
    const parent = parentOf(s.path) ?? '';
    const list = addedByParent.get(parent) ?? [];
    list.push(s);
    addedByParent.set(parent, list);
  }
  const claimed = new Set<string>();

  const shallowFirst = [...removed].sort((x, y) => depth(x.path) - depth(y.path));
  for (const symbol of shallowFirst) {
    const parent = parentOf(symbol.path);
    const parentHint = parent === undefined ? undefined : hints.get(parent);
    if (parentHint) {
      const counterpart = parentHint.replacement + symbol.path.slice((parent as string).length);
      const twin = addedByPath.get(counterpart);
      if (twin && twin.signature === symbol.signature && twin.kind === symbol.kind) {
        hints.set(symbol.path, { ...parentHint, replacement: counterpart });
        claimed.add(counterpart);
        continue;
      }
    }
    const candidates = (addedByParent.get(parent ?? '') ?? []).filter(
      (c) => c.kind === symbol.kind && !claimed.has(c.path),
    );
    const best = CONTAINER_KINDS.has(symbol.kind)
      ? pickContainerRename(symbol, candidates, allA, allB)
      : pickLeafRename(symbol, candidates);
    if (best) {
      hints.set(symbol.path, best);
      claimed.add(best.replacement);
    }
  }
  return hints;
}

function depth(path: string): number {
  return (path.match(/[.#]|\[\]/g) ?? []).length;
}

function unique<T extends { score: number }>(scored: T[]): T | undefined {
  const sorted = [...scored].sort((x, y) => y.score - x.score);
  const top = sorted[0];
  if (!top) return undefined;
  const runnerUp = sorted[1];
  return runnerUp && runnerUp.score === top.score ? undefined : top;
}

/** `string`, `boolean`, `number`: a signature that says nothing about which property this is. */
const TRIVIAL_SIGNATURE = /^(readonly |protected )*[A-Za-z_$][\w$]*$/;

function pickLeafRename(symbol: ApiSymbol, candidates: ApiSymbol[]): Hint | undefined {
  const trivial = TRIVIAL_SIGNATURE.test(symbol.signature);
  const scored = candidates
    .map((c) => {
      const same = c.signature === symbol.signature;
      const sig = same ? 1 : similarity(c.signature, symbol.signature);
      const name = similarity(leafOf(c.path), leafOf(symbol.path));
      return { c, same, name, score: sig + name / 10 };
    })
    .filter(({ same, score, name }) => (same || score >= 0.85) && (!trivial || name >= 0.5));
  const top = unique(scored);
  if (!top) return undefined;
  return {
    replacement: top.c.path,
    confidence: top.same ? 0.8 : 0.6,
    notes: top.same
      ? 'possibly renamed (identical signature)'
      : 'possibly renamed (similar signature)',
  };
}

function pickContainerRename(
  symbol: ApiSymbol,
  candidates: ApiSymbol[],
  allA: ApiSymbol[],
  allB: ApiSymbol[],
): Hint | undefined {
  const mine = memberFingerprints(symbol.path, allA);
  const scored = candidates
    .map((c) => {
      const name = similarity(leafOf(c.path), leafOf(symbol.path));
      const members = jaccard(mine, memberFingerprints(c.path, allB));
      return { c, name, members, score: name + members };
    })
    .filter(({ name, members }) => (mine.size === 0 ? name >= 0.8 : name >= 0.5 && members >= 0.5));
  const top = unique(scored);
  if (!top) return undefined;
  const strong = top.members >= 0.8 && top.name >= 0.6;
  return {
    replacement: top.c.path,
    confidence: strong ? 0.8 : 0.6,
    notes: strong
      ? 'possibly renamed (same members, similar name)'
      : 'possibly renamed (similar name and members)',
  };
}
