import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import {
  automaticTypes,
  repositoryTypescriptMajor,
  typescriptFiveDefaults,
} from './legacy-options.js';

describe("TypeScript 5's defaults under the bundled TypeScript 6", () => {
  it('fills what the tsconfig leaves unset the way TypeScript 5 did', () => {
    const d = typescriptFiveDefaults({});
    expect(d).toMatchObject({
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: false,
      allowSyntheticDefaultImports: false,
      strict: false,
      ignoreDeprecations: '6.0',
    });
    expect(d.types).toEqual([]);
  });

  it('keeps what is set, and derives the rest from it as TypeScript 5 did', () => {
    const esm = typescriptFiveDefaults({ target: ts.ScriptTarget.ES2022, strict: true });
    expect(esm.target).toBeUndefined();
    expect(esm.strict).toBeUndefined();
    expect(esm.module).toBe(ts.ModuleKind.ES2015);
    expect(esm.moduleResolution).toBe(ts.ModuleResolutionKind.Classic);
    const node = typescriptFiveDefaults({ module: ts.ModuleKind.NodeNext });
    expect(node).toMatchObject({
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    });
    const bundler = typescriptFiveDefaults({
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(bundler.allowSyntheticDefaultImports).toBe(true);
    expect(bundler.esModuleInterop).toBe(false);
  });

  it('includes every @types package of the type roots when `types` is unset', () => {
    const root = mkdtempSync(join(tmpdir(), 'uptide-legacy-'));
    const types = join(root, 'node_modules', '@types');
    for (const name of ['jest', 'react', 'scope__name'])
      mkdirSync(join(types, name), { recursive: true });
    mkdirSync(join(types, 'not-needed'), { recursive: true });
    writeFileSync(join(types, 'not-needed', 'package.json'), '{"typings": null}');
    mkdirSync(join(types, '.hidden'), { recursive: true });
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'tsconfig.json'), '{}');
    const options = { configFilePath: join(nested, 'tsconfig.json') } as ts.CompilerOptions;
    expect(automaticTypes(options)).toEqual(['jest', 'react', 'scope__name']);
    expect(typescriptFiveDefaults(options).types).toEqual(['jest', 'react', 'scope__name']);
    expect(typescriptFiveDefaults({ ...options, types: ['node'] }).types).toBeUndefined();
    // The repository's compiler, found from the workspace up.
    expect(repositoryTypescriptMajor(nested)).toBeUndefined();
    mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"version":"5.8.3"}');
    expect(repositoryTypescriptMajor(nested)).toBe(5);
  });
});
