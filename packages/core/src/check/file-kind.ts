import type { Finding, RuntimeReport } from '../domain/report.js';
import { isNativeProbeSkip, type RuntimeChange } from '../domain/runtime.js';
import type { Usage } from '../domain/usage.js';

/**
 * The arbiter by file kind. In a file the repository type-checks (TypeScript, or JavaScript
 * under `checkJs` / `// @ts-check`), the compiler decides (`match.ts`). In a file it does not
 * (`usage.checked === false`), "breaking" has to mean "throws or behaves differently at
 * runtime": a finding stays breaking only when Signal C saw a change the site actually hits.
 * Everything else the diff or the compiler claimed there is `info`, or `unverified` when the
 * probe could not conclude. Module-format findings are judged by `match.ts` per site.
 */
export function arbitrateUnchecked(
  findings: Finding[],
  runtime: RuntimeReport | undefined,
  loadRoot: string | undefined,
): Finding[] {
  return findings.map((f) => {
    if (f.usage.checked !== false) return f;
    if (f.change.kind === 'module-format' || f.change.kind === 'deprecated') return f;
    // Curated behaviour changes (express 5 routing) are about what a call does, not whether it loads.
    if (f.change.path.startsWith('runtime:')) return f;
    if (f.severity !== 'breaking' && f.severity !== 'unverified') return f;
    const hit =
      runtime && !runtime.inconclusive
        ? runtimeConfirms(f.usage, runtime.changes, loadRoot)
        : undefined;
    if (hit) {
      return {
        ...f,
        severity: 'breaking',
        reason: `${stripVerdict(f.reason)}; confirmed at runtime (${runtime?.node}): ${hit.detail}`,
      };
    }
    if (!runtime) {
      return {
        ...f,
        severity: 'unverified',
        reason: `${stripVerdict(f.reason)}; the repository does not type-check this file and the runtime probe did not run`,
      };
    }
    if (runtime.inconclusive) {
      return {
        ...f,
        severity: 'unverified',
        reason: isNativeProbeSkip(runtime.inconclusive)
          ? stripVerdict(f.reason)
          : `${stripVerdict(f.reason)}; the repository does not type-check this file and the runtime probe was inconclusive (${runtime.inconclusive})`,
      };
    }
    if (isScoped(f.usage.symbolPath)) {
      return {
        ...f,
        severity: 'unverified',
        reason: `${stripVerdict(f.reason)}; the repository does not type-check this file and the runtime probe only loads the package root`,
      };
    }
    return {
      ...f,
      severity: 'info',
      fixability: 'none',
      confidence: Math.min(f.confidence, 0.3),
      reason: `${f.change.source === 'types' && f.usage.compileError !== undefined ? 'the compiler' : 'the diff'} says ${f.change.kind === 'type' && f.usage.compileError !== undefined ? 'this would not type-check' : f.change.kind} but the repository does not type-check this file, and the target loads with the same shape at runtime (${runtime.node})`,
    };
  });
}

/** The runtime change this site would hit, if any. */
export function runtimeConfirms(
  usage: Usage,
  changes: RuntimeChange[],
  loadRoot: string | undefined,
): RuntimeChange | undefined {
  const loader = usage.loader ?? 'import';
  const own = changes.filter((c) => c.loader === loader);
  const throws = own.find((c) => c.kind === 'require-throws' || c.kind === 'import-throws');
  if (throws) return throws;
  if (isScoped(usage.symbolPath)) return undefined;
  const paths = usage.canonicalPath ? [usage.symbolPath, usage.canonicalPath] : [usage.symbolPath];
  for (const path of paths) {
    const { root, member } = split(path, loadRoot);
    if (root) {
      // The module value itself, used as a function or a constructor.
      if (member === undefined) {
        if (usage.access === 'call') {
          const hit = own.find((c) => c.kind === 'callable-lost' || c.kind === 'namespace-instead');
          if (hit) return hit;
        }
        if (usage.access === 'construct') {
          const hit = own.find(
            (c) =>
              c.kind === 'constructable-lost' ||
              c.kind === 'callable-lost' ||
              c.kind === 'namespace-instead',
          );
          if (hit) return hit;
        }
        continue;
      }
      const gone = own.find((c) => c.kind === 'key-removed' && c.key === member);
      if (gone) return gone;
      continue;
    }
    const key = member === undefined ? path : path.slice(0, path.length - member.length - 1);
    const gone = own.find((c) => c.kind === 'key-removed' && c.key === topKey(key));
    if (gone) return gone;
  }
  return undefined;
}

/**
 * `plain.hello` with load root `plain`: the root and the member `hello`. `makeClient`: a
 * named export, no root. `.` is the bare binding of the module value.
 */
function split(path: string, loadRoot: string | undefined): { root: boolean; member?: string } {
  const top = topKey(path);
  const isRoot = path === '.' || top === loadRoot || top === 'default';
  if (!isRoot)
    return { root: false, member: path.includes('.') ? path.slice(top.length + 1) : undefined };
  const rest = path.slice(top.length);
  const m = /^[.#]([^.#[(]+)/.exec(rest);
  return m ? { root: true, member: m[1] } : { root: true };
}

function topKey(path: string): string {
  const m = /^[^.#[(]+/.exec(path);
  return m ? m[0] : path;
}

function isScoped(path: string): boolean {
  return path.startsWith('"');
}

/** Earlier arbiters append their own clause; the runtime verdict replaces it. */
function stripVerdict(reason: string): string {
  return reason
    .replace(/; the compiler cannot type this file.*$/, '')
    .replace(/; the installed version ships no declarations.*$/, '');
}
