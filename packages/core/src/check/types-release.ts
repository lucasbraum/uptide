import { compareVersions, parseVersion } from './version.js';

/**
 * The `@types/<pkg>` release that goes with a runtime version: DefinitelyTyped tracks the
 * runtime's major and, for most packages, its minor (`@types/react` 19.0.x types react
 * 19.0, 19.2.x types 19.2). The newest release at the runtime's major.minor, else the newest
 * at its major, else the newest there is; never below what is installed (`@types/passport`
 * 1.x types passport 0.x). Undefined when nothing is published.
 */
export function typesReleaseFor(
  published: readonly string[],
  runtimeTarget: string,
  installed?: string,
): string | undefined {
  const target = parseVersion(runtimeTarget);
  const stable = published
    .filter((v) => {
      const p = parseVersion(v);
      return p !== undefined && p.pre === undefined;
    })
    .sort(compareVersions);
  const notBelowInstalled = (v: string): boolean =>
    installed === undefined || compareVersions(v, installed) >= 0;
  const newest = (match: (p: NonNullable<ReturnType<typeof parseVersion>>) => boolean) =>
    stable
      .filter(
        (v) =>
          notBelowInstalled(v) &&
          match(parseVersion(v) as NonNullable<ReturnType<typeof parseVersion>>),
      )
      .at(-1);
  if (!target) return newest(() => true);
  return (
    newest((p) => p.major === target.major && p.minor === target.minor) ??
    newest((p) => p.major === target.major) ??
    newest(() => true)
  );
}

/** `@types/react` for `react`, `@types/scope__name` for `@scope/name`. */
export function typesPackageOf(name: string): string {
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}

/** The runtime package a `@types/*` package types, or undefined for any other name. */
export function typedPackageOf(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  return name.slice('@types/'.length).replace(/^([^_]+)__/, '@$1/');
}
