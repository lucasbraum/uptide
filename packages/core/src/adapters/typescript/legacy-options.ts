import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ts } from 'ts-morph';

/**
 * The compiler bundled here is TypeScript 6, whose defaults for an option a tsconfig leaves
 * unset differ from TypeScript 5's: `strict` on, no automatic `@types` inclusion, a modern
 * `target`, `module` and resolution, `esModuleInterop` on. A repository on TypeScript 5 is
 * type-checked by its own compiler with the old defaults, and a check that silently used the
 * new ones would report errors (a strict-only null check, a missing test global) that are
 * nobody's. The defaults the repository's own compiler would use are made explicit here, so
 * the same tsconfig reads the same under both. A repository on TypeScript 6 is left as it is.
 */

/** The major of the TypeScript the repository installs, found from the workspace up. */
export function repositoryTypescriptMajor(from: string): number | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', 'typescript', 'package.json');
    if (existsSync(manifest)) {
      try {
        const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string })
          .version;
        const major = version ? Number.parseInt(version, 10) : Number.NaN;
        return Number.isNaN(major) ? undefined : major;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Every `@types/*` package in the type roots, as TypeScript 5 included them when `types` is
 * unset: each directory of `node_modules/@types` from the config's directory up, unless its
 * package.json says `"typings": null`.
 */
export function automaticTypes(options: ts.CompilerOptions): string[] {
  const roots = ts.getEffectiveTypeRoots(options, ts.sys) ?? [];
  const names: string[] = [];
  for (const root of roots) {
    if (!ts.sys.directoryExists(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifest = join(root, entry.name, 'package.json');
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).typings === null) continue;
      } catch {
        // No package.json, or an unreadable one: TypeScript 5 included the directory all the same.
      }
      if (!names.includes(entry.name)) names.push(entry.name);
    }
  }
  return names;
}

const { ES5, ES2015, ES2022, ES2023, ESNext } = ts.ScriptTarget;
const { CommonJS, Node16, Node18, Node20, NodeNext, Preserve, System } = ts.ModuleKind;

/**
 * TypeScript 5's values for the options `declared` leaves unset, as its `_computedOptions`
 * derive them: target ES5 (ES2022/ES2023/ESNext under the node modules), module from the
 * target, resolution from the module, interop only under the node modules and `preserve`.
 */
export function typescriptFiveDefaults(declared: ts.CompilerOptions): ts.CompilerOptions {
  const out: ts.CompilerOptions = {};
  const module = declared.module;
  const target =
    declared.target ??
    (module === Node16 || module === Node18
      ? ES2022
      : module === Node20
        ? ES2023
        : module === NodeNext
          ? ESNext
          : ES5);
  if (declared.target === undefined) out.target = target;
  const moduleKind = module ?? (target >= ES2015 ? ts.ModuleKind.ES2015 : CommonJS);
  if (module === undefined) out.module = moduleKind;
  if (declared.moduleResolution === undefined) {
    out.moduleResolution =
      moduleKind === CommonJS
        ? ts.ModuleResolutionKind.Node10
        : moduleKind === Node16
          ? ts.ModuleResolutionKind.Node16
          : moduleKind === Node18 || moduleKind === Node20 || moduleKind === NodeNext
            ? ts.ModuleResolutionKind.NodeNext
            : moduleKind === Preserve
              ? ts.ModuleResolutionKind.Bundler
              : ts.ModuleResolutionKind.Classic;
  }
  const resolution = declared.moduleResolution ?? out.moduleResolution;
  const nodeish = [Node16, Node18, Node20, NodeNext, Preserve].includes(moduleKind);
  const interop = declared.esModuleInterop ?? nodeish;
  if (declared.esModuleInterop === undefined) out.esModuleInterop = interop;
  if (declared.allowSyntheticDefaultImports === undefined)
    out.allowSyntheticDefaultImports =
      interop || moduleKind === System || resolution === ts.ModuleResolutionKind.Bundler;
  if (declared.strict === undefined) out.strict = false;
  if (declared.types === undefined) out.types = automaticTypes(declared);
  // The old defaults are deprecated under the new compiler, not wrong: no diagnostic for them.
  out.ignoreDeprecations = '6.0';
  return out;
}
