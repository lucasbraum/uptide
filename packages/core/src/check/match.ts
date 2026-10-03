import type { Change, Severity } from '../domain/change.js';
import { parentOf } from '../domain/path.js';
import type { Finding } from '../domain/report.js';
import type { RuntimeLoad } from '../domain/runtime.js';
import { USAGE_CERTAINTY, type Usage, usagePaths } from '../domain/usage.js';
import { resolveDirection } from './direction.js';
import { fixabilityOf } from './fixability.js';

/**
 * Pure and language-agnostic: joins changes to usages by canonical path, resolves the
 * severities milestone 1 had to defer, and prices each finding.
 *
 * A usage answers to every path in `usagePaths` (the name written and its canonical
 * target). A `removed` or `moved` change also reaches usages of the symbol's members: if
 * `Parser` is gone, `parser.parse()` is affected too.
 */
export interface MatchOptions {
  /** Signal B ran and its diagnostics were merged: the compiler is the arbiter for what it can judge. */
  compiled?: boolean;
  /**
   * Paths whose declaration file in the target has unresolved imports: the compiler's
   * silence about them proves nothing.
   */
  unverifiedPaths?: Set<string>;
  /**
   * Used path -> paths of the types its signature names (`StripeConfig#apiVersion` ->
   * `Stripe.LatestApiVersion`). A change to such a type reaches the usage through it.
   */
  references?: Map<string, string[]>;
  /** Top-level export paths of the target: what `require(esm)` hands back as named properties. */
  esmNamed?: Set<string>;
  /** Signal C: what `require()` of the target really returned on the repository's Node. Outranks `esmNamed`. */
  targetRequire?: RuntimeLoad;
  /**
   * Every symbol path of the target. A removed re-export container (`core`) is no removal
   * for a site whose written name (`FileTypeResult`) still exists at the top level.
   */
  targetPaths?: Set<string>;
}

/** Kinds of a referenced type's change that reach the symbol naming it. */
const THROUGH_REFERENCE = new Set<Change['kind']>([
  'type',
  'narrowed',
  'widened',
  'signature',
  'removed',
]);

/** Kinds the compiler can judge: if the code still compiles, the diff's verdict is explanation, not fact. */
const COMPILE_TIME_KINDS = new Set<Change['kind']>([
  'removed',
  'moved',
  'renamed',
  'signature',
  'required',
  'type',
  'narrowed',
]);

/**
 * The compiler decides, the diff explains. When Signal B saw the usage and raised no new
 * diagnostic, a breaking verdict of a compile-time kind becomes `info` ("diff says X but
 * your code compiles against the target"), or `unverified` when the symbol's declaration
 * file has unresolved imports in the target (the compiler could not judge). A widening
 * below 0.8 the compiler accepted is `info` too. Deprecations are untouched.
 */
function arbitrate(finding: Finding, options: MatchOptions): Finding {
  // A file the repository does not type-check is judged by the runtime probe instead (check/file-kind.ts).
  if (finding.usage.checked === false) return finding;
  if (
    options.compiled !== true ||
    finding.severity !== 'breaking' ||
    finding.usage.compileError !== undefined
  )
    return finding;
  const { change } = finding;
  if (COMPILE_TIME_KINDS.has(change.kind)) {
    if (options.unverifiedPaths?.has(change.path)) {
      return {
        ...finding,
        severity: 'unverified',
        reason: `${finding.reason}; the declaration file has unresolved imports in the target, compile check inconclusive`,
      };
    }
    return {
      ...finding,
      severity: 'info',
      fixability: 'none',
      confidence: 0.3,
      reason: `diff says ${change.kind} but your code compiles against the target`,
    };
  }
  if (change.kind === 'widened' && finding.confidence < 0.8) {
    return {
      ...finding,
      severity: 'info',
      fixability: 'none',
      confidence: 0.3,
      reason: `${finding.reason}; compiles against target; possible runtime change`,
    };
  }
  return finding;
}

export function match(changes: Change[], usages: Usage[], options: MatchOptions = {}): Finding[] {
  const byPath = new Map<string, Change[]>();
  for (const change of changes) {
    const list = byPath.get(change.path) ?? [];
    list.push(change);
    byPath.set(change.path, list);
  }
  const containerChanges = changes.filter((c) => c.kind === 'removed' || c.kind === 'moved');
  const formatChanges = changes.filter((c) => c.kind === 'module-format');

  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (change: Change, usage: Usage, inherited: boolean, through?: string): void => {
    const key = `${usage.file}:${usage.line}:${usage.column}:${usage.symbolPath}:${change.path}:${change.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const resolved = resolveDirection(change, usage);
    let severity: Severity = resolved?.severity ?? change.severity;
    let reason =
      resolved?.reason ??
      (inherited
        ? `${change.path} was ${change.kind}; this member goes with it`
        : (change.notes ?? defaultReason(change)));
    if (through !== undefined) reason = `${change.path}, the type of ${through}, ${reason}`;
    // The compiler is the ground truth for "will it compile": its rejection outranks the
    // direction table. A deprecation is not what broke the line, so it keeps its severity.
    if (
      usage.compileError !== undefined &&
      severity !== 'breaking' &&
      change.kind !== 'deprecated'
    ) {
      severity = 'breaking';
      reason = `compiler rejects this usage: ${usage.compileError.split('\n')[0]}`;
    }
    findings.push({
      change,
      usage,
      severity,
      confidence: round(change.confidence * USAGE_CERTAINTY[usage.via]),
      fixability: fixabilityOf(change, usage, severity),
      reason,
    });
  };

  for (const usage of usages) {
    const paths = usagePaths(usage);
    // An import line is only affected when the name stops existing where it is imported from.
    const relevant = (change: Change): boolean =>
      usage.access !== 'import' ||
      change.kind === 'removed' ||
      change.kind === 'moved' ||
      change.kind === 'renamed' ||
      change.kind === 'module-format';
    // The package went ESM-only: every require() site is affected, whatever it touches.
    for (const change of formatChanges) {
      if (usage.loader !== 'require') continue;
      const key = `${usage.file}:${usage.line}:${usage.column}:${usage.symbolPath}:.:module-format`;
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = options.targetRequire
        ? observedRequireVerdict(change, usage, options.targetRequire)
        : requireEsmVerdict(change, usage, options.esmNamed, options.targetPaths);
      if (!verdict) continue;
      findings.push({
        change,
        usage,
        severity: verdict.severity,
        confidence: round(change.confidence * USAGE_CERTAINTY[usage.via]),
        fixability: 'assisted',
        reason: `${change.notes ?? 'no longer loadable with require()'}${verdict.detail}`,
      });
    }
    // The name written and its canonical target carry the same changes; report each kind once,
    // under the name the consumer wrote. A deprecation applies only to the name written:
    // `z.infer` does not inherit `TypeOf`'s tag through the alias.
    const kindsSeen = new Set<Change['kind']>();
    for (const path of paths) {
      for (const change of byPath.get(path) ?? []) {
        if (!relevant(change) || kindsSeen.has(change.kind)) continue;
        if (change.kind === 'deprecated' && path !== usage.symbolPath) continue;
        kindsSeen.add(change.kind);
        add(change, usage, false);
      }
    }
    // A change to a type the used symbol's signature names reaches the usage through it.
    for (const path of paths) {
      for (const ref of options.references?.get(path) ?? []) {
        for (const change of byPath.get(ref) ?? []) {
          if (THROUGH_REFERENCE.has(change.kind) && relevant(change))
            add(change, usage, false, path);
        }
      }
    }
    // A removed or moved container yields one finding per site, for its outermost ancestor:
    // if `sharp` is gone, `sharp.ResizeOptions#width` is gone with it, and saying so three times helps nobody.
    for (const kind of ['removed', 'moved'] as const) {
      const ancestors = containerChanges
        .filter((c) => c.kind === kind && paths.some((p) => isDescendant(p, c.path)))
        // A re-export container went away (`core`), but the symbol under it still exists at
        // the target's top level (`FileTypeResult`): nothing was removed from where this site
        // looks, whether the name was written through the container or through an alias of it.
        .filter(
          (c) =>
            options.targetPaths === undefined ||
            !survivesWithout(c.path, paths, options.targetPaths),
        )
        .sort((x, y) => x.path.length - y.path.length);
      const outermost = ancestors[0];
      if (outermost) add(outermost, usage, true);
    }
  }

  // One diagnostic, one finding: a confirmed usage keeps the change that best explains the
  // compiler's error and drops the rest, so `url()` rejected by the compiler is one line,
  // not one per change the diff knows about `url`.
  const confirmedOrder: Change['kind'][] = [
    'removed',
    'moved',
    'renamed',
    'required',
    'signature',
    'narrowed',
    'type',
    'widened',
    'deprecated',
    'added',
  ];
  const bestFor = new Map<Usage, Finding>();
  for (const f of findings) {
    if (f.usage.compileError === undefined || f.severity !== 'breaking') continue;
    // A module-format finding is a load-time fact, not an explanation of the diagnostic.
    if (!confirmedOrder.includes(f.change.kind)) continue;
    const current = bestFor.get(f.usage);
    if (
      !current ||
      f.confidence > current.confidence ||
      (f.confidence === current.confidence &&
        confirmedOrder.indexOf(f.change.kind) < confirmedOrder.indexOf(current.change.kind))
    )
      bestFor.set(f.usage, f);
  }
  const oneEach = findings.filter((f) => {
    const best = bestFor.get(f.usage);
    return (
      best === undefined ||
      best === f ||
      f.severity !== 'breaking' ||
      !confirmedOrder.includes(f.change.kind)
    );
  });
  findings.length = 0;
  findings.push(...oneEach);

  // The same collapse for a direct hit: `sharp.ResizeOptions#width removed` on a site whose
  // `sharp removed` finding already exists is the same news.
  const collapsed = findings.filter((f) => {
    const gone = findings.some(
      (g) =>
        g !== f &&
        g.usage === f.usage &&
        (g.change.kind === 'removed' || g.change.kind === 'moved') &&
        g.change.path === f.usage.symbolPath,
    );
    // The name the consumer wrote is gone: a type it referenced, or the container of the
    // alias it resolved to (`core` for `fromBuffer` -> `core.fromBuffer`), adds no news.
    const aliasContainer =
      f.usage.canonicalPath !== undefined &&
      isDescendant(f.usage.canonicalPath, f.change.path) &&
      !isDescendant(f.usage.symbolPath, f.change.path);
    if (gone && (f.reason.includes(', the type of ') || aliasContainer)) return false;
    if (f.change.kind !== 'removed' && f.change.kind !== 'moved') return true;
    return !findings.some(
      (g) =>
        g !== f &&
        g.usage === f.usage &&
        g.change.kind === f.change.kind &&
        isDescendant(f.change.path, g.change.path),
    );
  });
  findings.length = 0;
  findings.push(...collapsed);

  // One site, one root cause: seven symbols removed at the same line (a destructuring import
  // of a package that dropped them) are one finding listing the symbols, not seven. Runs
  // after the ancestor collapse, so nested paths are already one finding.
  const bySite = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.change.kind !== 'removed' && f.change.kind !== 'moved') continue;
    if (f.severity !== 'breaking') continue;
    const key = `${f.usage.file}:${f.usage.line}:${f.change.kind}`;
    const list = bySite.get(key) ?? [];
    list.push(f);
    bySite.set(key, list);
  }
  const dropped = new Set<Finding>();
  for (const list of bySite.values()) {
    const paths = [...new Set(list.map((f) => f.change.path))].sort();
    if (paths.length < 2) continue;
    const [first, ...rest] = list;
    if (!first) continue;
    first.reason = `${paths.length} symbols ${first.change.kind} at this site: ${paths.join(', ')}`;
    for (const f of rest) dropped.add(f);
  }
  if (dropped.size > 0) {
    const kept = findings.filter((f) => !dropped.has(f));
    findings.length = 0;
    findings.push(...kept);
  }

  // A package that went ESM-only: switching a file to `import()` is one unit of work, however
  // many lines `require()` it. One finding per file and verdict, with every site listed.
  const perFile = new Map<string, Finding>();
  const folded = new Set<Finding>();
  for (const f of findings) {
    if (f.change.kind !== 'module-format') continue;
    const key = `${f.change.package}|${f.usage.file}|${f.severity}|${f.reason}`;
    const head = perFile.get(key);
    if (!head) {
      perFile.set(key, f);
      f.sites = [{ line: f.usage.line, snippet: f.usage.snippet }];
      continue;
    }
    if (!head.sites?.some((s) => s.line === f.usage.line))
      head.sites?.push({ line: f.usage.line, snippet: f.usage.snippet });
    folded.add(f);
  }
  if (folded.size > 0) {
    const kept = findings.filter((f) => !folded.has(f));
    findings.length = 0;
    findings.push(...kept);
  }

  const rank: Record<Severity, number> = {
    breaking: 0,
    unverified: 1,
    deprecated: 2,
    additive: 3,
    info: 4,
  };
  return findings
    .map((f) => arbitrate(f, options))
    .sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        a.usage.file.localeCompare(b.usage.file) ||
        a.usage.line - b.usage.line ||
        a.usage.column - b.usage.column ||
        a.change.path.localeCompare(b.change.path),
    );
}

/**
 * What a `require()` of an ESM-only target does at this site. Without require(esm) every
 * site breaks. With it, the namespace object comes back: destructured or accessed named
 * exports work, calling or constructing the module itself does not (a default export needs
 * `.default`), members that live on the default export are not on the namespace, and a
 * graph with top-level await cannot be required at all. Unknown Node: unverified.
 */
function requireEsmVerdict(
  change: Change,
  usage: Usage,
  esmNamed: Set<string> | undefined,
  targetPaths?: Set<string>,
): { severity: Severity; detail: string } | undefined {
  const pkg = change.package;
  const isRoot =
    usage.symbolPath === '.' ||
    usage.symbolPath === 'default' ||
    usage.symbolPath === change.loadRoot;
  if (change.requireEsm === 'unknown') {
    return {
      severity: 'unverified',
      detail: '; whether this require() keeps working depends on the Node version',
    };
  }
  if (change.requireEsm === 'no') return { severity: 'breaking', detail: '' };
  if (change.topLevelAwait) {
    return {
      severity: 'breaking',
      detail: `; require('${pkg}') throws at load time; use import()`,
    };
  }
  if (isRoot) {
    if (usage.access === 'call' || usage.access === 'construct') {
      return {
        severity: 'breaking',
        detail: `; require('${pkg}') now returns a namespace, so the value at this site is not a function or class; use require('${pkg}').default or import()`,
      };
    }
    // The binding itself: nothing breaks until a member is touched, and members have their own sites.
    return undefined;
  }
  const root = change.loadRoot ?? 'default';
  const onDefault =
    usage.symbolPath.startsWith(`${root}#`) || usage.symbolPath.startsWith(`${root}.`);
  const leaf = onDefault
    ? (usage.symbolPath.slice(root.length + 1).split(/[.#[(]/)[0] ?? usage.symbolPath)
    : (usage.symbolPath.split(/[.#[]/)[0] ?? usage.symbolPath);
  if (
    !onDefault &&
    (esmNamed === undefined || esmNamed.has(leaf) || esmNamed.has(usage.symbolPath))
  )
    return undefined;
  // Not a named export, and not on the default export either: a removal, the diff's story.
  if (
    !onDefault &&
    targetPaths !== undefined &&
    !targetPaths.has(`${root}.${leaf}`) &&
    !targetPaths.has(`${root}#${leaf}`)
  )
    return undefined;
  return {
    severity: 'breaking',
    detail: `; \`${leaf}\` is not a named export of ${pkg}, it lives on the default export: use require('${pkg}').default.${leaf} or import()`,
  };
}

/**
 * The same question answered by observation: Signal C loaded the target with `require()`
 * on the repository's Node. A throw breaks every site; a namespace breaks the sites that call
 * or construct the module value, and the sites whose member is on the default export only.
 */
function observedRequireVerdict(
  change: Change,
  usage: Usage,
  observed: RuntimeLoad,
): { severity: Severity; detail: string } | undefined {
  const pkg = change.package;
  if (!observed.ok) {
    const code = observed.code ?? 'an error';
    return {
      severity: 'breaking',
      detail: `; require('${pkg}') throws ${code} on the repository's Node${code === 'ERR_REQUIRE_ASYNC_MODULE' ? ' (top-level await)' : ''}; use import()`,
    };
  }
  const isRoot =
    usage.symbolPath === '.' ||
    usage.symbolPath === 'default' ||
    usage.symbolPath === change.loadRoot;
  if (isRoot) {
    if ((usage.access === 'call' || usage.access === 'construct') && !observed.callable) {
      return {
        severity: 'breaking',
        detail: `; require('${pkg}') returns a namespace on the repository's Node, so the value at this site is not a function or class; use require('${pkg}').default or import()`,
      };
    }
    return undefined;
  }
  const root = change.loadRoot ?? 'default';
  const onDefault =
    usage.symbolPath.startsWith(`${root}#`) || usage.symbolPath.startsWith(`${root}.`);
  const leaf = onDefault
    ? (usage.symbolPath.slice(root.length + 1).split(/[.#[(]/)[0] ?? usage.symbolPath)
    : (usage.symbolPath.split(/[.#[]/)[0] ?? usage.symbolPath);
  const keys = observed.keys ?? {};
  if (leaf in keys) return undefined;
  if (observed.defaultKeys?.includes(leaf)) {
    return {
      severity: 'breaking',
      detail: `; \`${leaf}\` is not on the namespace require('${pkg}') returns, it lives on the default export: use require('${pkg}').default.${leaf} or import()`,
    };
  }
  // Neither on the namespace nor on the default: a removal, which the diff reports itself.
  return undefined;
}

/** Whether the symbol a site reaches under a removed container is still there without it. */
function survivesWithout(container: string, paths: string[], targetPaths: Set<string>): boolean {
  return paths.some((path) => {
    const rest = isDescendant(path, container) ? path.slice(container.length + 1) : path;
    return targetPaths.has(topLevelOf(rest));
  });
}

/** `FileTypeResult#mime` -> `FileTypeResult`; `"./sub":X.y` -> `"./sub":X`. */
function topLevelOf(path: string): string {
  const m = /^("[^"]*":)?[^.#[(]+/.exec(path);
  return m ? m[0] : path;
}

function isDescendant(path: string, ancestor: string): boolean {
  if (path === ancestor) return false;
  let p = parentOf(path);
  while (p !== undefined) {
    if (p === ancestor) return true;
    p = parentOf(p);
  }
  return false;
}

function defaultReason(change: Change): string {
  switch (change.kind) {
    case 'removed':
      return change.replacement ? `removed, possibly renamed to ${change.replacement}` : 'removed';
    case 'moved':
      return `moved to ${change.replacement ?? 'another entry point'}`;
    case 'added':
      return 'added';
    case 'deprecated':
      return 'deprecated';
    case 'required':
      return 'now required';
    default:
      return `${change.kind} changed`;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
